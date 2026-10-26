'use strict';
/* 스핀 클래시 온라인 서버 (방 코드 1:1)
 * - 게임 파일을 그대로 서빙하고(온라인 버튼 활성화 스크립트 주입), /ws 로 WebSocket 접속을 받는다.
 * - 서버는 전투를 계산하지 않는다: 시드·시작 신호·입력/해시 중계만 한다 (두 폰이 같은 계산을 한다).
 * 실행: node server.js   (환경변수: PORT, GAME_FILE, LAT_MS, JIT_MS(테스트용 인위 지연))
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const LAT_MS = +process.env.LAT_MS || 0, JIT_MS = +process.env.JIT_MS || 0;   // 테스트용 인위 지연
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function readGame() {
  let h = fs.readFileSync(GAME_FILE, 'utf8');
  const inj = '<script>window.SPIN_ONLINE=1;</script>';
  return h.indexOf('<head>') >= 0 ? h.replace('<head>', '<head>' + inj) : inj + h;
}

const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html') {
    let body; try { body = readGame(); } catch (e) { res.writeHead(500); res.end('game file missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body);
  } else if (u === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok rooms=' + rooms.size); }
  else { res.writeHead(404); res.end('not found'); }
});

const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function newCode() {
  for (let n = 0; n < 50; n++) {
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function rawSend(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
/* 인위 지연을 걸되 순서는 유지 (TCP처럼) */
function relay(ws, o) {
  if (!LAT_MS && !JIT_MS) return rawSend(ws, o);
  ws._q = ws._q || []; const due = Date.now() + LAT_MS + Math.random() * JIT_MS;
  const last = ws._q.length ? ws._q[ws._q.length - 1].due : 0;
  ws._q.push({ due: Math.max(due, last), o });
  if (!ws._tm) { const pump = () => { ws._tm = null; const now = Date.now(); while (ws._q.length && ws._q[0].due <= now) rawSend(ws, ws._q.shift().o); if (ws._q.length) ws._tm = setTimeout(pump, Math.max(1, ws._q[0].due - now)); }; ws._tm = setTimeout(pump, 1); }
}
function other(room, idx) { const p = room.players[1 - idx]; return p ? p.ws : null; }

/* 클래식 덱 검사: 3개, 무기 종류 중복 없음, 스펠 중복 없음 */
function validDeck(d) {
  if (!Array.isArray(d) || d.length !== 3) return false;
  const types = new Set(), spells = new Set();
  for (const x of d) {
    if (!x || typeof x !== 'object' || typeof x.type !== 'string' || x.type.length > 24 || types.has(x.type)) return false;
    types.add(x.type);
    const sp = Array.isArray(x.spells) ? x.spells : [];
    if (sp.length > 2) return false;
    for (const k of sp) { if (typeof k !== 'string' || k.length > 24 || spells.has(k)) return false; spells.add(k); }
  }
  return true;
}
function startClassic(room) {
  const [a, b] = room.players;
  room.cl = { decks: [a.deck, b.deck], used: [[false, false, false], [false, false, false]], picks: [null, null], wins: [0, 0], rd: 0, end: false };
  room.state = 'cpick'; room.over = [false, false]; room.rematch = [false, false];
  const msg = { t: 'cstart', decks: room.cl.decks, arena: room.arena, sd: room.sd !== false };
  relay(a.ws, msg); relay(b.ws, msg);
}
function classicNext(room) {
  const cl = room.cl; if (!cl || cl.end) return;
  room.state = 'cpick'; cl.picks = [null, null]; room.rematch = [false, false];
  room.players.forEach((p) => { if (p) relay(p.ws, { t: 'cnext', rd: cl.rd }); });
}
function startFight(room) {
  const cl = room.cl, pk = cl.picks.slice();
  cl.used[0][pk[0]] = true; cl.used[1][pk[1]] = true; cl.rd++; cl.picks = [null, null];
  startRound(room, [cl.decks[0][pk[0]], cl.decks[1][pk[1]]], pk);
}
function startRound(room, sels, pk) {
  const [a, b] = room.players;
  const path = ((a.rtt || 60) + (b.rtt || 60)) / 2;   // 두 사람 사이 한쪽 방향 지연(ms) = 서버까지 편도 둘의 합
  const D = Math.max(4, Math.min(24, Math.ceil(path / 16.667) + 3));   // 입력 지연(프레임): 경로 지연 + 여유 3프레임
  room.round++; room.state = 'play'; room.over = [false, false]; room.rematch = [false, false];
  const seed = crypto.randomInt(0, 4294967296);
  const msg = { t: 'start', seed, arena: room.arena, sd: room.sd !== false, sel: sels || [a.sel, b.sel], D, round: room.round };
  if (pk) { msg.pk = pk; msg.rd = room.cl.rd; }
  relay(a.ws, msg); relay(b.ws, msg);
}

wss.on('connection', (ws) => {
  ws._room = null; ws._idx = -1; ws._cnt = 0; ws._win = Date.now();
  ws.on('message', (data) => {
    if (!LAT_MS && !JIT_MS) return handle(data);
    ws._iq = ws._iq || []; const due = Date.now() + LAT_MS + Math.random() * JIT_MS; const last = ws._iq.length ? ws._iq[ws._iq.length - 1].due : 0;
    ws._iq.push({ due: Math.max(due, last), data });
    if (!ws._it) { const pump = () => { ws._it = null; const n = Date.now(); while (ws._iq.length && ws._iq[0].due <= n) handle(ws._iq.shift().data); if (ws._iq.length) ws._it = setTimeout(pump, Math.max(1, ws._iq[0].due - n)); }; ws._it = setTimeout(pump, 1); }
  });
  function handle(data) {
    const now = Date.now(); if (now - ws._win > 1000) { ws._win = now; ws._cnt = 0; }
    if (++ws._cnt > 400) { ws.close(1008, 'rate'); return; }
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws._room;
    switch (m.t) {
      case 'ping': return relay(ws, { t: 'pong', c: m.c });
      case 'create': {
        if (room) return;
        const code = newCode(); if (!code) return rawSend(ws, { t: 'err', m: '방을 만들 수 없어요' });
        const mode = m.mode === 'classic' ? 'classic' : 'single';
        const r = { code, mode, cl: null, players: [{ ws, sel: null, ready: false, rtt: 60 }, null], arena: 0, state: 'lobby', round: 0, over: [false, false], rematch: [false, false], hs: [{}, {}] };
        rooms.set(code, r); ws._room = r; ws._idx = 0;
        return rawSend(ws, { t: 'created', code, idx: 0, mode });
      }
      case 'join': {
        if (room) return;
        const code = String(m.code || '').toUpperCase().trim(); const r = rooms.get(code);
        if (!r) return rawSend(ws, { t: 'err', m: '그런 방이 없어요' });
        if (r.players[1]) return rawSend(ws, { t: 'err', m: '이미 가득 찬 방이에요' });
        r.players[1] = { ws, sel: null, ready: false, rtt: 60 }; ws._room = r; ws._idx = 1;
        rawSend(ws, { t: 'joined', code, idx: 1, mode: r.mode }); rawSend(r.players[0].ws, { t: 'peer', n: 2 });
        return;
      }
      case 'sel': {   // 내 선택 + (방장이면) 경기장 + 측정한 지연
        if (!room || room.state !== 'lobby' || room.mode === 'classic') return;
        const p = room.players[ws._idx]; if (!p || typeof m.sel !== 'object' || !m.sel) return;
        p.sel = m.sel; p.rtt = Math.max(0, Math.min(2000, +m.rtt || 60));
        if (ws._idx === 0 && Number.isInteger(m.arena) && m.arena >= 0 && m.arena < 64) room.arena = m.arena;
        if (ws._idx === 0 && typeof m.sd === 'boolean') room.sd = m.sd;
        return;
      }
      case 'deck': {   // 클래식: 내 덱 3개(+방장이면 경기장) 저장. 상대에게는 둘 다 확정하고 시작할 때 공개
        if (!room || room.mode !== 'classic' || room.state !== 'lobby') return;
        const p = room.players[ws._idx]; if (!p || !validDeck(m.deck)) return;
        p.deck = m.deck; p.sel = m.deck[0]; p.rtt = Math.max(0, Math.min(2000, +m.rtt || 60));
        if (ws._idx === 0 && Number.isInteger(m.arena) && m.arena >= 0 && m.arena < 64) room.arena = m.arena;
        if (ws._idx === 0 && typeof m.sd === 'boolean') room.sd = m.sd;
        return;
      }
      case 'pick': {   // 클래식: 이번 판에 낼 캐릭터를 몰래 고름. 둘 다 고르면 그때 공개하며 전투 시작
        const cl = room && room.cl; if (!cl || room.state !== 'cpick') return;
        const i = m.i; if (!Number.isInteger(i) || i < 0 || i > 2 || cl.used[ws._idx][i] || cl.picks[ws._idx] !== null) return;
        cl.picks[ws._idx] = i;
        const o = other(room, ws._idx); if (o) relay(o, { t: 'peerPicked' });
        if (cl.picks[0] !== null && cl.picks[1] !== null) startFight(room);
        return;
      }
      case 'ready': {
        if (!room || room.state !== 'lobby') return;
        const p = room.players[ws._idx]; if (!p || !p.sel) return;
        p.ready = !!m.v; const o = other(room, ws._idx); if (o) rawSend(o, { t: 'peerReady', v: p.ready });
        const [a, b] = room.players;
        if (a && b && a.ready && b.ready) { if (room.mode === 'classic') { if (a.deck && b.deck) startClassic(room); } else startRound(room); }
        return;
      }
      case 'pv': {   // 상대 미리보기용 무기 종류만 중계 (재능·스펠은 시작 전까지 비공개)
        if (!room || (room.state !== 'lobby' && room.state !== 'after')) return;
        if (typeof m.type !== 'string' || m.type.length > 24) return;
        const o = other(room, ws._idx); if (o) rawSend(o, { t: 'peerPv', type: m.type });
        return;
      }
      case 'in': case 'h': {   // 입력/해시 중계
        if (!room || room.state !== 'play') return;
        const o = other(room, ws._idx); if (o) { m.p = ws._idx; relay(o, m); }
        return;
      }
      case 'over': {   // 양쪽이 판이 끝났다고 보고하면 로비 상태(재대결 대기)로
        if (!room || room.state !== 'play') return;
        room.over[ws._idx] = true; room.hs[ws._idx].w = m.w;
        if (room.over[0] && room.over[1]) {
          room.state = 'after';
          const cl = room.cl;
          if (cl && room.mode === 'classic') {   // 클래식: 두 쪽이 같은 승자를 보고했을 때만 점수 반영
            const w0 = room.hs[0].w, w1 = room.hs[1].w;
            let res;
            if (w0 !== w1 || ![-1, 0, 1].includes(w0)) res = { t: 'cres', bad: true };
            else {
              if (w0 >= 0) cl.wins[w0]++;
              cl.end = cl.wins[0] >= 2 || cl.wins[1] >= 2 || cl.rd >= 3;
              res = { t: 'cres', w: w0, wins: cl.wins.slice(), rd: cl.rd, end: cl.end, mw: cl.end ? (cl.wins[0] > cl.wins[1] ? 0 : (cl.wins[1] > cl.wins[0] ? 1 : -1)) : -2 };
            }
            room.players.forEach((p) => { if (p) relay(p.ws, res); });
          }
        }
        return;
      }
      case 'rematch': {
        if (!room || (room.state !== 'after' && room.state !== 'play')) return;
        room.rematch[ws._idx] = !!m.v; const o = other(room, ws._idx); if (o) rawSend(o, { t: 'peerRematch', v: !!m.v });
        if (room.rematch[0] && room.rematch[1] && room.players[0] && room.players[1]) { if (room.mode === 'classic') classicNext(room); else startRound(room); }
        return;
      }
      case 'back': {   // 선택 화면으로 돌아가기 (둘 다 준비 해제)
        if (!room) return;
        room.state = 'lobby'; room.cl = null; room.players.forEach((p) => { if (p) p.ready = false; });
        const o = other(room, ws._idx); if (o) rawSend(o, { t: 'peerBack' });
        return;
      }
      case 'leave': return ws.close();
    }
  }
  ws.on('close', () => {
    const room = ws._room; if (!room) return;
    const o = other(room, ws._idx);
    room.players[ws._idx] = null;
    if (o) { rawSend(o, { t: 'left' }); room.state = 'lobby'; room.cl = null; }
    if (!room.players[0] && !room.players[1]) rooms.delete(room.code);
    else if (o) { /* 남은 사람은 방장이 된다 */ if (ws._idx === 0) { room.players[0] = room.players[1]; room.players[1] = null; room.players[0].ws._idx = 0; rawSend(room.players[0].ws, { t: 'host' }); } room.players.forEach((p) => { if (p) { p.ready = false; } }); }
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log('spinclash server on :' + PORT + (LAT_MS || JIT_MS ? ' (인위지연 ' + LAT_MS + '+' + JIT_MS + 'ms)' : '')));
