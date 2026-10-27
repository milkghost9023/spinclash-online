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
const accounts = require('./accounts')();

const PORT = +process.env.PORT || 8080;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const LAT_MS = +process.env.LAT_MS || 0, JIT_MS = +process.env.JIT_MS || 0;   // 테스트용 인위 지연
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRACE_MS = +process.env.GRACE_MS || 40000;   // 연결이 끊긴 플레이어를 기다려 주는 시간
const PICK_MS = +process.env.PICK_MS || 45000;     // 클래식에서 캐릭터를 고르는 제한 시간

/* 서버 버전 = 게임 파일의 버전 표시. 버전이 다른 화면은 입장·재접속을 막는다 */
let verCache = { mt: 0, v: '' };
function serverVer() {
  try { const mt = fs.statSync(GAME_FILE).mtimeMs; if (mt !== verCache.mt) { const h = fs.readFileSync(GAME_FILE, 'utf8'); const m = h.match(/class="verTag">([^<]+)</); verCache = { mt, v: m ? m[1].trim() : '' }; } } catch (e) {}
  return verCache.v;
}
function verOk(ws, m) {
  const v = serverVer(); if (!v || m.ver === v) return true;
  rawSend(ws, { t: 'err', c: 'ver', m: '새 버전(' + v + ')이 나왔어요. 새로고침해 주세요', v }); return false;
}
function readGame() {
  let h = fs.readFileSync(GAME_FILE, 'utf8');
  const inj = '<script>window.SPIN_ONLINE=1;' + (accounts.enabled ? 'window.SPIN_ACC=1;' : '') + '</script>';
  return h.indexOf('<head>') >= 0 ? h.replace('<head>', '<head>' + inj) : inj + h;
}

const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u.indexOf('/api/') === 0) { accounts.handle(req, res).then((h) => { if (!h && !res.headersSent) { res.writeHead(404); res.end('not found'); } }, () => { if (!res.headersSent) { res.writeHead(500); res.end('error'); } }); return; }
  if (u === '/' || u === '/index.html') {
    let body; try { body = readGame(); } catch (e) { res.writeHead(500); res.end('game file missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body);
  } else if (u === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok rooms=' + rooms.size + ' online=' + onlineCount() + ' acc=' + accounts.state); }
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
  if (!ws) return;
  if (!LAT_MS && !JIT_MS) return rawSend(ws, o);
  ws._q = ws._q || []; const due = Date.now() + LAT_MS + Math.random() * JIT_MS;
  const last = ws._q.length ? ws._q[ws._q.length - 1].due : 0;
  ws._q.push({ due: Math.max(due, last), o });
  if (!ws._tm) { const pump = () => { ws._tm = null; const now = Date.now(); while (ws._q.length && ws._q[0].due <= now) rawSend(ws, ws._q.shift().o); if (ws._q.length) ws._tm = setTimeout(pump, Math.max(1, ws._q[0].due - now)); }; ws._tm = setTimeout(pump, 1); }
}
function other(room, idx) { const p = idx >= 0 ? room.players[1 - idx] : null; return p ? p.ws : null; }

const MAX_SPEC = 8, MAX_ROOMS = 300;
/* 닉네임·방 이름 정리: 제어/보이지 않는 글자 제거, 공백 정리, 글자 수 제한 */
function cleanText(s, max) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}
/* "유령"(유우령 등 늘린 변형 포함)이 들어간 닉네임은 제작자 전용: 제작자 코드(해시로만 비교)를 보낸 사람만 쓸 수 있다. 공백·보이지 않는 글자를 끼운 변형도 같이 막는다 */
const CMD_HASH = crypto.createHash('sha256').update('command').digest('hex');
function isGhost(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').search(/유[유우]*령/) >= 0; }
function cmdOk(cp) { return typeof cp === 'string' && cp.length < 40 && crypto.createHash('sha256').update(cp.trim().toLowerCase()).digest('hex') === CMD_HASH; }
function nickOf(s, cp) { const n = cleanText(s, 10); if ((isGhost(n) && !cmdOk(cp)) || accounts.nickTaken(n)) return '손님' + (1000 + crypto.randomInt(9000)); return n || ('손님' + (1000 + crypto.randomInt(9000))); }   // 가입자가 쓰는 닉네임을 손님이 따라 쓸 수 없다
function namesOf(room) { return room.players.map((p) => (p ? p.nick : '')); }
function sendNames(room) {
  const o = { t: 'names', n: namesOf(room), sc: room.specs.length };
  room.players.forEach((p) => { if (p) rawSend(p.ws, o); }); room.specs.forEach((w) => rawSend(w, o));
}
/* 관전자에게 보내는 방 상태 (전투 중에는 'start' 메시지가 대신한다) */
function specStatus(room, only) {
  const cl = room.cl;
  const o = { t: 'sst', st: room.state, np: room.players.filter(Boolean).length, n: namesOf(room), name: room.name, mode: room.mode,
    cl: cl ? { decks: cl.decks, used: cl.used, res: cl.res, wins: cl.wins, rd: cl.rd, end: cl.end } : null };
  if (only) rawSend(only, o); else room.specs.forEach((w) => rawSend(w, o));
}
/* 접속 중인 사람 수: 페이지를 열어 둔 연결(hi 를 보낸 연결)만 센다. 변할 때마다 0.6초 모아서 한 번에 알린다 */
let countT = null, lastCount = -1;
function onlineCount() { let n = 0; wss.clients.forEach((w) => { if (w._pres) n++; }); return n; }
function schedCount() {
  if (countT) return;
  countT = setTimeout(() => { countT = null; const n = onlineCount(); if (n === lastCount) return; lastCount = n; const o = JSON.stringify({ t: 'online', n }); wss.clients.forEach((w) => { if (w._pres && w.readyState === 1) w.send(o); }); }, 600);
}
function pwOk(ws, r, m) {
  if (!r.pw) return true;
  if (String(m.pw == null ? '' : m.pw) === r.pw) return true;
  ws._pwFail = (ws._pwFail | 0) + 1; if (ws._pwFail > 6) { ws.close(1008, 'pw'); return false; }
  rawSend(ws, { t: 'err', c: m.pw ? 'wrongpw' : 'pw', m: m.pw ? '비밀번호가 달라요' : '비밀번호가 필요한 방이에요' });
  return false;
}

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
  room.cl = { decks: [a.deck, b.deck], used: [[false, false, false], [false, false, false]], res: [[null, null, null], [null, null, null]], picks: [null, null], cur: null, wins: [0, 0], rd: 0, end: false };
  room.state = 'cpick'; room.over = [false, false]; room.rematch = [false, false];
  const msg = { t: 'cstart', decks: room.cl.decks, arena: room.arena, sd: room.sd !== false, pt: PICK_MS };
  relay(a.ws, msg); relay(b.ws, msg); specStatus(room); armPick(room);
}
/* 고르는 제한 시간: 시간이 지나면 못 고른 쪽은 안 쓴 캐릭터 중 하나가 무작위로 정해진다 */
function killPick(room) { if (room.pickT) { clearTimeout(room.pickT); room.pickT = null; } if (room.cl) room.cl.dl = 0; }
function armPick(room) {
  killPick(room); const cl = room.cl; if (!cl) return;
  cl.dl = Date.now() + PICK_MS;
  room.pickT = setTimeout(() => {
    room.pickT = null; if (room.state !== 'cpick' || !room.cl) return;
    [0, 1].forEach((i) => {
      if (cl.picks[i] !== null) return;
      const free = [0, 1, 2].filter((k) => !cl.used[i][k]); if (!free.length) return;
      cl.picks[i] = free[crypto.randomInt(free.length)];
      const o = other(room, i); if (o) relay(o, { t: 'peerPicked' });
    });
    if (cl.picks[0] !== null && cl.picks[1] !== null) startFight(room);
  }, PICK_MS);
}
function classicNext(room) {
  const cl = room.cl; if (!cl || cl.end) return;
  room.state = 'cpick'; cl.picks = [null, null]; room.rematch = [false, false];
  room.players.forEach((p) => { if (p) relay(p.ws, { t: 'cnext', rd: cl.rd, pt: PICK_MS }); }); specStatus(room); armPick(room);
}
function startFight(room) {
  killPick(room);
  const cl = room.cl, pk = cl.picks.slice();
  cl.used[0][pk[0]] = true; cl.used[1][pk[1]] = true; cl.rd++; cl.picks = [null, null]; cl.cur = pk;
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
  msg.nm = namesOf(room);
  room.lastStart = msg; room.log = []; room.lastIn = [-1, -1]; room.lastCres = null;
  relay(a.ws, msg); relay(b.ws, msg);
  if (room.specs.length) { const sm = Object.assign({}, msg, { log: [], li: [-1, -1] }); room.specs.forEach((w) => rawSend(w, sm)); }
}

/* 재접속한 사람에게 보내는 방 상태 전체: 이걸로 화면을 다시 맞추고, 전투 중이면 입력 기록으로 처음부터 다시 계산한다 */
function snapshot(r, idx) {
  const cl = r.cl;
  const o = { t: 'resumed', idx, code: r.code, mode: r.mode, name: r.name, st: r.state, np: r.players[1 - idx] ? 1 : 0, n: namesOf(r), sc: r.specs.length,
    ready: [!!(r.players[0] && r.players[0].ready), !!(r.players[1] && r.players[1].ready)], rematch: r.rematch.slice(), over: r.over.slice(), arena: r.arena, sd: r.sd !== false,
    cl: cl ? { decks: cl.decks, used: cl.used, res: cl.res, wins: cl.wins, rd: cl.rd, end: cl.end, cur: cl.cur, mypick: cl.picks[idx], opicked: cl.picks[1 - idx] !== null, dl: cl.dl ? Math.max(0, cl.dl - Date.now()) : 0 } : null,
    cres: r.lastCres || null };
  if ((r.state === 'play' || r.state === 'after') && r.lastStart) { o.start = Object.assign({}, r.lastStart, { nm: namesOf(r) }); o.log = r.log; o.li = r.lastIn; }
  return o;
}
/* 플레이어를 방에서 내보낸다 (직접 나갔거나, 기다리는 시간이 지났을 때) */
function dropPlayer(room, idx) {
  const p = room.players[idx]; if (!p) return;
  if (p.graceT) { clearTimeout(p.graceT); p.graceT = null; }
  const hasOther = !!room.players[1 - idx], o = other(room, idx);
  room.players[idx] = null;
  if (hasOther) { if (o) rawSend(o, { t: 'left' }); room.state = 'lobby'; room.cl = null; room.lastStart = null; killPick(room); }
  if (!room.players[0] && !room.players[1]) { killPick(room); room.specs.forEach((w) => { rawSend(w, { t: 'sclosed' }); w._room = null; }); room.specs = []; rooms.delete(room.code); }
  else if (hasOther) {   // 남은 사람은 방장이 된다
    if (idx === 0) { room.players[0] = room.players[1]; room.players[1] = null; if (room.players[0].ws) { room.players[0].ws._idx = 0; rawSend(room.players[0].ws, { t: 'host' }); } }
    room.players.forEach((q) => { if (q) q.ready = false; }); sendNames(room); specStatus(room);
  }
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
    /* 로그인한 사람이면 방 만들기·참가·관전 때 세션 토큰으로 계정을 확인한다 (닉네임은 계정 것이 우선) */
    if (m._u === undefined && typeof m.tk === 'string' && m.tk && (m.t === 'create' || m.t === 'join' || m.t === 'spec') && accounts.enabled && !ws._room) {
      if (ws._authing) return; ws._authing = true;
      accounts.userFromToken(m.tk).then((u) => {
        ws._authing = false; if (ws.readyState !== 1) return;
        if (!u) return rawSend(ws, { t: 'err', c: 'auth', m: '로그인이 만료됐어요. 다시 로그인해 주세요' });
        m._u = u; run(m);
      });
      return;
    }
    run(m);
  }
  function run(m) {
    const room = ws._room;
    if (ws._idx === -2 && m.t !== 'ping' && m.t !== 'leave' && m.t !== 'list') return;
    switch (m.t) {
      case 'ping': return relay(ws, { t: 'pong', c: m.c });
      case 'hi': { if (!ws._pres) { ws._pres = true; rawSend(ws, { t: 'online', n: onlineCount() }); schedCount(); } const sv = serverVer(); if (sv && m.ver !== sv) rawSend(ws, { t: 'ver', v: sv }); return; }
      case 'create': {
        if (room) return;
        const code = newCode(); if (!code) return rawSend(ws, { t: 'err', m: '방을 만들 수 없어요' });
        if (!verOk(ws, m)) return;
        const mode = m.mode === 'classic' ? 'classic' : (m.mode === 'nospell' ? 'nospell' : 'single');
        if (rooms.size >= MAX_ROOMS) return rawSend(ws, { t: 'err', m: '지금은 방을 더 만들 수 없어요' });
        const nick = m._u ? m._u.nick : nickOf(m.nick, m.cp), name = cleanText(m.name, 16) || (nick + '의 방'), pw = cleanText(m.pw, 8);
        const r = { code, mode, name, pw, spec: m.spec !== false, specs: [], lastStart: null, log: [], lastIn: [-1, -1], cl: null, players: [{ ws, nick, uid: m._u ? m._u.id : 0, tok: crypto.randomBytes(12).toString('hex'), sel: null, ready: false, rtt: 60 }, null], arena: 0, pickT: null, lastCres: null, state: 'lobby', round: 0, over: [false, false], rematch: [false, false], hs: [{}, {}] };
        rooms.set(code, r); ws._room = r; ws._idx = 0;
        rawSend(ws, { t: 'created', code, idx: 0, mode, name, tok: r.players[0].tok }); sendNames(r);
        return;
      }
      case 'join': {
        if (room) return;
        const code = String(m.code || '').toUpperCase().trim(); const r = rooms.get(code);
        if (!r) return rawSend(ws, { t: 'err', m: '그런 방이 없어요' });
        if (r.players[1]) return rawSend(ws, { t: 'err', m: '이미 가득 찬 방이에요' });
        if (!verOk(ws, m)) return;
        if (!pwOk(ws, r, m)) return;
        r.players[1] = { ws, nick: m._u ? m._u.nick : nickOf(m.nick, m.cp), uid: m._u ? m._u.id : 0, tok: crypto.randomBytes(12).toString('hex'), sel: null, ready: false, rtt: 60 }; ws._room = r; ws._idx = 1;
        rawSend(ws, { t: 'joined', code, idx: 1, mode: r.mode, name: r.name, tok: r.players[1].tok }); rawSend(r.players[0].ws, { t: 'peer', n: 2 });
        sendNames(r); specStatus(r);
        if (r.players[0] && r.players[0].ready) rawSend(ws, { t: 'peerReady', v: true });   // 방장이 미리 준비해 뒀다면 바로 알려 준다
        return;
      }
      case 'spec': {   // 관전: 두 사람의 입력을 똑같이 받아서 같은 계산을 한다 (조작·채팅 불가)
        if (room) return;
        const code = String(m.code || '').toUpperCase().trim(); const r = rooms.get(code);
        if (!r) return rawSend(ws, { t: 'err', m: '그런 방이 없어요' });
        if (!verOk(ws, m)) return;
        if (!r.spec) return rawSend(ws, { t: 'err', m: '관전을 허용하지 않는 방이에요' });
        if (r.specs.length >= MAX_SPEC) return rawSend(ws, { t: 'err', m: '관전 자리가 가득 찼어요' });
        if (!pwOk(ws, r, m)) return;
        ws._room = r; ws._idx = -2; ws._nick = m._u ? m._u.nick : nickOf(m.nick, m.cp); r.specs.push(ws);
        rawSend(ws, { t: 'sjoined', code, mode: r.mode, name: r.name, n: namesOf(r) }); sendNames(r);
        if (r.state === 'play' && r.lastStart) rawSend(ws, Object.assign({}, r.lastStart, { nm: namesOf(r), log: r.log, li: r.lastIn }));
        else specStatus(r, ws);
        return;
      }
      case 'resume': {   // 연결이 끊겼다가 돌아온 플레이어: 방 번호 + 비밀 토큰으로 자기 자리를 되찾는다
        if (room) return;
        if (!verOk(ws, m)) return;
        const r = rooms.get(String(m.code || '').toUpperCase()), tok = String(m.tok || '');
        const idx = r ? r.players.findIndex((q) => q && q.tok === tok) : -1;
        if (idx < 0) return rawSend(ws, { t: 'err', c: 'noresume', m: '방이 사라졌어요' });
        const p = r.players[idx];
        if (p.graceT) { clearTimeout(p.graceT); p.graceT = null; }
        if (p.ws && p.ws !== ws) { const old = p.ws; old._room = null; try { old.close(); } catch (e) {} }
        p.ws = ws; ws._room = r; ws._idx = idx;
        rawSend(ws, snapshot(r, idx));
        const o = other(r, idx); if (o) rawSend(o, { t: 'peerReturn' });
        return;
      }
      case 'list': {
        const out = [];
        rooms.forEach((r) => { const np = r.players.filter(Boolean).length; if (!np) return; const h = r.players[0] || r.players[1]; out.push({ c: r.code, nm: r.name, md: r.mode, h: h.nick, np, st: r.state, lk: !!r.pw, sp: r.spec, sc: r.specs.length }); });
        out.sort((x, y) => (x.np - y.np) || (x.c < y.c ? -1 : 1));
        return rawSend(ws, { t: 'rooms', l: out.slice(0, 40) });
      }
      case 'sel': {   // 내 선택 + (방장이면) 경기장 + 측정한 지연
        if (!room || room.state !== 'lobby' || room.mode === 'classic') return;
        const p = room.players[ws._idx]; if (!p || typeof m.sel !== 'object' || !m.sel) return;
        p.sel = room.mode === 'nospell' ? Object.assign({}, m.sel, { spells: [] }) : m.sel; p.rtt = Math.max(0, Math.min(2000, +m.rtt || 60));
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
        if (m.t === 'in') {   // 관전자용 기록: 비어 있지 않은 입력만 저장하고, 어디까지 받았는지(lastIn)만 따로 기억한다
          if (!Number.isInteger(m.f) || m.f < 0 || m.f > 1000000 || !Array.isArray(m.a) || m.a.length > 2) return;
          m.a = m.a.filter((j) => j === 0 || j === 1);
          if (m.f <= room.lastIn[ws._idx]) return;   // 이미 받은 프레임(재전송 등)은 무시
          room.lastIn[ws._idx] = m.f;
          if (m.a.length && room.log.length < 8000) room.log.push([ws._idx, m.f, m.a]);
          if (room.specs.length) { const so = { t: 'in', p: ws._idx, f: m.f, a: m.a }; room.specs.forEach((w) => rawSend(w, so)); }
        }
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
              if (cl.cur) { cl.res[0][cl.cur[0]] = w0 === 0 ? 'W' : (w0 === 1 ? 'L' : 'D'); cl.res[1][cl.cur[1]] = w0 === 1 ? 'W' : (w0 === 0 ? 'L' : 'D'); }
              res = { t: 'cres', w: w0, wins: cl.wins.slice(), rd: cl.rd, end: cl.end, mw: cl.end ? (cl.wins[0] > cl.wins[1] ? 0 : (cl.wins[1] > cl.wins[0] ? 1 : -1)) : -2 };
            }
            room.lastCres = res; room.players.forEach((p) => { if (p) relay(p.ws, res); });
          }
          specStatus(room);
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
        room.state = 'lobby'; room.cl = null; killPick(room); room.players.forEach((p) => { if (p) p.ready = false; });
        const o = other(room, ws._idx); if (o) rawSend(o, { t: 'peerBack' });
        specStatus(room);
        return;
      }
      case 'leave': ws._leaving = true; return ws.close();
    }
  }
  ws.on('close', () => {
    if (ws._iq && ws._iq.length) { const q = ws._iq; ws._iq = []; q.forEach((e) => handle(e.data)); }   // (지연 시뮬레이션용) 닫히기 전에 도착한 메시지를 먼저 처리
    if (ws._pres) schedCount();
    const room = ws._room; if (!room) return;
    if (ws._idx === -2) { room.specs = room.specs.filter((w) => w !== ws); sendNames(room); return; }
    const idx = ws._idx, p = room.players[idx];
    if (!p || p.ws !== ws) return;   // 이미 재접속으로 다른 연결이 이 자리를 잇고 있다
    if (ws._leaving) return dropPlayer(room, idx);
    /* 갑자기 끊김: 자리를 잠시 비워 두고 기다린다. 돌아오면 이어서 한다 */
    p.ws = null;
    const o = other(room, idx); if (o) rawSend(o, { t: 'peerGone', g: GRACE_MS });
    p.graceT = setTimeout(() => { p.graceT = null; if (room.players[idx] === p && !p.ws) dropPlayer(room, idx); }, GRACE_MS);
  });
  ws.on('error', () => {});
});

accounts.init().catch((e) => console.log('[accounts] 시작 오류:', e && e.message));
server.listen(PORT, () => console.log('spinclash server on :' + PORT + (LAT_MS || JIT_MS ? ' (인위지연 ' + LAT_MS + '+' + JIT_MS + 'ms)' : '')));
