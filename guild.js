'use strict';
/* 스핀 클래시 길드 (v811 · 1단계: 만들기 · 찾기 · 가입 · 직급 · 채팅 · 친선전 · 관전 · 제작자 도구)
 * - 계정 모듈(accounts.js)의 DB 연결을 같이 쓴다. 로그인한 계정만 길드에 들어갈 수 있다
 * - 요청은 POST /api/guild {k: ...} 하나로 모은다 (accounts.handle 이 넘겨 준다)
 * - 실시간 알림은 접속 인원용 연결(presence WebSocket)로 보낸다: {t:'g', k:'msg'|'msgup'|'msgdel'|'upd'|'app'|'in'|'out'}
 * - 재화(다이아 500 만들기 비용 · 보상)는 아직 기기 저장이라 게임 쪽에서 처리한다 (서버 경제 작업 때 옮김)
 * - 뒤로 미룬 것: 토큰 지원(길드원끼리 토큰 주고받기)은 서버 경제 작업 뒤에 (claude/길드_기획.md 12번) */
const crypto = require('crypto');

const MAX_MEMBERS = 30;                 /* 인원 30명 고정 (민준 확정) */
const LEAVE_CD_MS = 12 * 3600 * 1000;   /* 나오거나 추방된 뒤 다른 길드 가입까지 12시간 */
const AWAY_MS = 14 * 86400 * 1000;      /* 길드장이 14일 안 들어오면 자동 위임 */
const CHAT_SEND = 100, CHAT_KEEP = 300, MSG_MAX = 120, DESC_MAX = 60, NOTICE_MAX = 80;
const MIN_TR = [0, 300, 600, 1000];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMB_BG = 12, EMB_RING = 6, EMOTES = 12;
const RING_LV = [1, 1, 1, 1, 5, 8];     /* 테두리 무늬 4 · 5는 길드 레벨 5 · 8에 열림 (레벨은 3단계에서) */

/* 욕설 필터: 글자 사이에 공백·기호를 끼워도 잡는다. 채팅은 ** 로 가리고, 길드 이름 · 소개 · 공지는 거절 */
const BAD = ['시발', '씨발', '씨빨', '씨바', '시바', '쓰발', 'ㅅㅂ', 'ㅆㅂ', 'ㅅ1발', '병신', '븅신', '빙신', 'ㅂㅅ', '좆', 'ㅈ같', '좃같', '지랄', 'ㅈㄹ', '개새끼', '개새기', '개색', '개쉐', '개섀', '느금', '니미', '니애미', '애미', '애비', '엠창', '앰창', '창녀', '걸레년', '썅', '꼴통', '닥쳐', '죽어라', '자살', 'fuck', 'shit', 'bitch', 'asshole', 'nigger', 'sex'];
const SEP = '[\\s\\-_.,~!?*^`\'"0-9]*';
const BAD_RE = new RegExp(BAD.map((w) => Array.from(w).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(SEP)).join('|'), 'gi');
function badHas(s) { BAD_RE.lastIndex = 0; return BAD_RE.test(String(s || '')); }
function badMask(s) { return String(s || '').replace(BAD_RE, (m) => '*'.repeat(Math.min(6, Array.from(m).length))); }
const INVIS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
function clean(s, n) { return Array.from(String(s == null ? '' : s).replace(INVIS, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).join('').trim(); }
function nameKey(s) { return String(s || '').normalize('NFKC').replace(/[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').toLowerCase(); }
const isGhost = (s) => nameKey(s).search(/유[유우]*령/) >= 0;

module.exports = function createGuild(acc, hook) {
  const G = { enabled: false };
  let q = null, send = null, fail = null, rate = null;
  const gidMap = new Map();      /* user id → guild id (접속 연결에 길드 번호를 붙이는 데 씀) */
  const duelMap = new Map();     /* 방 코드 → { gid, mid } 친선전 카드 */
  const seenAt = new Map();      /* user id → 마지막으로 seen_at 을 적은 시각 (10분에 한 번만 DB에) */

  const SCHEMA = `
CREATE TABLE IF NOT EXISTS guilds (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  code TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT '',
  notice TEXT NOT NULL DEFAULT '',
  emb JSONB NOT NULL DEFAULT '{}'::jsonb,
  join_mode SMALLINT NOT NULL DEFAULT 0,
  min_tr INTEGER NOT NULL DEFAULT 0,
  xp BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guilds_name_uq ON guilds (name_key);
CREATE UNIQUE INDEX IF NOT EXISTS guilds_code_uq ON guilds (code);
CREATE TABLE IF NOT EXISTS guild_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  role SMALLINT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tr INTEGER NOT NULL DEFAULT 0,
  ico TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS guild_members_g_idx ON guild_members (guild_id);
CREATE TABLE IF NOT EXISTS guild_apps (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tr INTEGER NOT NULL DEFAULT 0,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS guild_msgs (
  id BIGSERIAL PRIMARY KEY,
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL DEFAULT 0,
  nick TEXT NOT NULL DEFAULT '',
  k TEXT NOT NULL,
  body JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_msgs_g_idx ON guild_msgs (guild_id, id DESC);
CREATE TABLE IF NOT EXISTS guild_reports (
  id BIGSERIAL PRIMARY KEY,
  msg_id BIGINT NOT NULL,
  guild_id INTEGER NOT NULL,
  reporter INTEGER NOT NULL,
  target INTEGER NOT NULL,
  txt TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guild_reports_uq ON guild_reports (msg_id, reporter);`;

  G.init = async function init() {
    if (!acc.enabled || !acc.x) { console.log('[guild] 꺼짐: 계정 기능이 꺼져 있어요'); return; }
    ({ q, send, fail, rate } = acc.x);
    try {
      await q(SCHEMA);
      const r = await q('SELECT user_id, guild_id FROM guild_members');
      r.rows.forEach((x) => gidMap.set(x.user_id, x.guild_id));
      G.enabled = true;
      console.log('[guild] 켜짐 · 길드원 ' + gidMap.size + '명');
    } catch (e) { console.log('[guild] 준비 실패:', e.message); return; }
    const t = setInterval(() => { housekeep().catch((e) => console.log('[guild] 정리 오류:', e.message)); }, 3600 * 1000); t.unref();
    housekeep().catch(() => {});
  };
  G.gidOf = (uid) => (uid && gidMap.get(uid)) || 0;
  function setGid(uid, gid) { if (gid) gidMap.set(uid, gid); else gidMap.delete(uid); if (hook.setGid) hook.setGid(uid, gid || 0); }
  /* 접속 연결이 로그인을 알려 줄 때마다 (10분에 한 번) 마지막 접속 시각을 남긴다: 길드장 자동 위임 · 길드원 목록 '○시간 전'용 */
  G.seen = function seen(uid) {
    if (!G.enabled || !uid || !gidMap.has(uid)) return;
    const now = Date.now(); if (now - (seenAt.get(uid) || 0) < 600000) return; seenAt.set(uid, now);
    q('UPDATE guild_members SET seen_at = now() WHERE user_id = $1', [uid]).catch(() => {});
  };

  /* ── 공통 ── */
  const ms = (d) => (d instanceof Date ? d.getTime() : (d ? new Date(d).getTime() : 0));
  function embClean(e, lv) {
    e = e && typeof e === 'object' ? e : {};
    const bg = Math.floor(+e.bg), ring = Math.floor(+e.ring), ico = String(e.ico || '');
    return { bg: bg >= 0 && bg < EMB_BG ? bg : 0, ring: ring >= 0 && ring < EMB_RING && RING_LV[ring] <= (lv || 1) ? ring : 0, ico: /^[a-z0-9_]{1,24}$/.test(ico) ? ico : 'sword' };
  }
  const lvOf = (xp) => 1;   /* 길드 레벨은 3단계(기여도)에서. 지금은 모두 Lv.1 */
  function pubGuild(g, n) { return { id: g.id, name: g.name, code: g.code, descr: g.descr, emb: g.emb, join: g.join_mode, minT: g.min_tr, lv: lvOf(g.xp), n: n == null ? (g.n | 0) : n, max: MAX_MEMBERS }; }
  function roomSt(code) { const r = hook.roomInfo ? hook.roomInfo(code) : null; return !r ? 'end' : (r.np >= 2 ? 'play' : 'wait'); }
  function msgOut(row) {
    const o = { i: +row.id, u: row.user_id, n: row.nick, k: row.k, b: row.body || {}, at: ms(row.at) };
    if (o.k === 'd' && o.b.code) o.b = Object.assign({}, o.b, { st: roomSt(o.b.code) });
    return o;
  }
  async function guildRow(gid) { const r = await q('SELECT * FROM guilds WHERE id = $1', [gid]); return r.rows[0] || null; }
  async function memberRow(uid) { const r = await q('SELECT * FROM guild_members WHERE user_id = $1', [uid]); return r.rows[0] || null; }
  async function members(gid) {
    const r = await q('SELECT m.user_id, m.role, m.joined_at, m.seen_at, m.tr, m.ico, u.nick FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 ORDER BY m.role DESC, m.joined_at ASC', [gid]);
    return r.rows;
  }
  async function addMsg(gid, u, k, body) {
    const r = await q('INSERT INTO guild_msgs (guild_id, user_id, nick, k, body) VALUES ($1, $2, $3, $4, $5) RETURNING *', [gid, u ? u.id : 0, u ? u.nick : '', k, body || {}]);
    const m = msgOut(r.rows[0]);
    if (hook.pushGid) hook.pushGid(gid, { t: 'g', k: 'msg', m });
    return m;
  }
  const sys = (gid, body) => addMsg(gid, null, 's', body);
  const upd = (gid) => { if (hook.pushGid) hook.pushGid(gid, { t: 'g', k: 'upd' }); };
  async function cdLeft(uid) {
    const r = await q("SELECT (data->>'gcd')::bigint AS c FROM users WHERE id = $1", [uid]);
    const c = r.rows[0] && r.rows[0].c ? +r.rows[0].c : 0; return Math.max(0, c - Date.now());
  }
  const cdSet = (uid) => q("UPDATE users SET data = data || jsonb_build_object('gcd', $2::bigint) WHERE id = $1", [uid, Date.now() + LEAVE_CD_MS]);
  function cdMsg(left) { const t = Math.ceil(left / 60000), h = Math.floor(t / 60), m = t % 60; return '길드에서 나온 지 얼마 안 됐어요. ' + (h ? h + '시간 ' : '') + (m || !h ? m + '분 ' : '') + '뒤에 들어갈 수 있어요'; }
  async function newCode() {
    for (let n = 0; n < 40; n++) {
      let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      const r = await q('SELECT 1 FROM guilds WHERE code = $1', [c]); if (!r.rows.length) return c;
    }
    throw new Error('code');
  }
  /* 길드장이 없거나(계정 삭제) 오래 안 들어오면 넘겨 준다: 부길드장 중 가장 먼저 임명된(먼저 들어온) 사람 → 없으면 가장 최근에 들어온 멤버 */
  async function fixLeader(gid, list, why) {
    list = list || await members(gid);
    if (!list.length) { await q('DELETE FROM guilds WHERE id = $1', [gid]); return; }
    const lead = list.find((m) => m.role === 2), now = Date.now();
    if (lead && (why !== 'away' || now - ms(lead.seen_at) < AWAY_MS)) return;
    const live = list.filter((m) => m.role !== 2 && now - ms(m.seen_at) < AWAY_MS);
    const pick = live.filter((m) => m.role === 1).sort((a, b) => ms(a.joined_at) - ms(b.joined_at))[0] || live.sort((a, b) => ms(b.seen_at) - ms(a.seen_at))[0] || (lead ? null : list[0]);
    if (!pick) return;
    if (lead) await q('UPDATE guild_members SET role = 1 WHERE user_id = $1', [lead.user_id]);
    await q('UPDATE guild_members SET role = 2 WHERE user_id = $1', [pick.user_id]);
    await sys(gid, { s: 'auto', a: pick.nick, b: lead ? lead.nick : '' }); upd(gid);
  }
  async function housekeep() {
    if (!G.enabled) return;
    const r = await q("SELECT g.id FROM guilds g WHERE NOT EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = g.id AND m.role = 2 AND m.seen_at > now() - interval '14 days')");
    for (const row of r.rows) await fixLeader(row.id, null, 'away');
    await q('DELETE FROM guild_msgs WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY guild_id ORDER BY id DESC) AS rn FROM guild_msgs) t WHERE t.rn > ' + CHAT_KEEP + ')');
  }

  /* 내 길드 전부 (정보 · 길드원 · 최근 채팅 100개 · 간부면 가입 신청) */
  async function full(uid, mem) {
    const g = await guildRow(mem.guild_id); if (!g) return null;
    let list = await members(g.id);
    if (!list.some((m) => m.role === 2)) { await fixLeader(g.id, list); list = await members(g.id); mem = await memberRow(uid) || mem; }
    const msgs = (await q('SELECT * FROM guild_msgs WHERE guild_id = $1 ORDER BY id DESC LIMIT ' + CHAT_SEND, [g.id])).rows.reverse().map(msgOut);
    const out = pubGuild(g, list.length);
    out.notice = g.notice; out.myRole = mem.role;
    out.members = list.map((m) => { const p = hook.presOf ? hook.presOf(m.user_id) : null; return { u: m.user_id, n: m.nick, r: m.role, tr: m.tr, ico: m.ico, j: ms(m.joined_at), s: ms(m.seen_at), on: p ? p.ps || 'home' : '' }; });
    out.msgs = msgs;
    if (mem.role >= 1) out.apps = (await q('SELECT a.user_id, a.tr, a.at, u.nick FROM guild_apps a JOIN users u ON u.id = a.user_id WHERE a.guild_id = $1 ORDER BY a.at ASC LIMIT 50', [g.id])).rows.map((a) => ({ u: a.user_id, n: a.nick, tr: a.tr, at: ms(a.at) }));
    return out;
  }
  async function meOut(u) {
    const mem = await memberRow(u.id);
    if (!mem) { setGid(u.id, 0); const apps = (await q('SELECT guild_id FROM guild_apps WHERE user_id = $1', [u.id])).rows.map((r) => r.guild_id); return { ok: true, uid: u.id, g: null, cd: await cdLeft(u.id), apps }; }
    if (gidMap.get(u.id) !== mem.guild_id) setGid(u.id, mem.guild_id);
    return { ok: true, uid: u.id, g: await full(u.id, mem), cd: 0, apps: [] };
  }
  async function listOut(where, vals) {
    const r = await q('SELECT g.*, (SELECT count(*) FROM guild_members m WHERE m.guild_id = g.id)::int AS n, (SELECT max(at) FROM guild_msgs x WHERE x.guild_id = g.id) AS act FROM guilds g ' + where, vals || []);
    return r.rows.map((g) => pubGuild(g, g.n));
  }
  /* 실제로 길드원이 되는 곳 (자유 가입 · 초대 코드 · 신청 수락) */
  async function enter(uid, nick, gid, tr) {
    try { await q('INSERT INTO guild_members (user_id, guild_id, role, tr) VALUES ($1, $2, 0, $3)', [uid, gid, tr | 0]); }
    catch (e) { if (e && e.code === '23505') return 'already'; throw e; }
    const n = (await q('SELECT count(*)::int AS n FROM guild_members WHERE guild_id = $1', [gid])).rows[0].n;
    if (n > MAX_MEMBERS) { await q('DELETE FROM guild_members WHERE user_id = $1 AND guild_id = $2', [uid, gid]); return 'full'; }
    await q('DELETE FROM guild_apps WHERE user_id = $1', [uid]);
    setGid(uid, gid); await sys(gid, { s: 'join', a: nick }); upd(gid);
    return '';
  }
  async function leaveOut(uid, gid) { setGid(uid, 0); await cdSet(uid); if (hook.pushUid) hook.pushUid(uid, { t: 'g', k: 'out' }); }
  const trOk = (g, tr) => (tr | 0) >= (g.min_tr | 0);
  const vTr = (x) => { x = Math.floor(+x); return Number.isFinite(x) && x >= 0 && x < 1e7 ? x : 0; };

  G.req = async function req(u, b, res) {
    if (!G.enabled) return fail(res, 503, 'off', '길드 기능이 아직 꺼져 있어요');
    const k = String(b.k || '');
    if (!rate('gd:' + u.id, 120, 60 * 1000)) return fail(res, 429, 'rate', '너무 빨리 눌렀어요. 잠시 후 다시 해 주세요');
    if (k.indexOf('own.') === 0) return ownReq(u, k, b, res);
    if (k === 'me') {
      const mem = await memberRow(u.id);
      if (mem) { const tr = vTr(b.tr), ico = /^[a-z0-9_]{1,24}$/.test(String(b.ico || '')) ? String(b.ico) : mem.ico; await q('UPDATE guild_members SET seen_at = now(), tr = $2, ico = $3 WHERE user_id = $1', [u.id, tr, ico]); seenAt.set(u.id, Date.now()); }
      return send(res, 200, await meOut(u));
    }
    if (k === 'list') return send(res, 200, { ok: true, list: await listOut('ORDER BY (SELECT count(*) FROM guild_members m WHERE m.guild_id = g.id) >= ' + MAX_MEMBERS + ' ASC, (g.join_mode = 2) ASC, act DESC NULLS LAST, g.id DESC LIMIT 20') });
    if (k === 'search') {
      const s = clean(b.q, 12); if (!s) return send(res, 200, { ok: true, list: [] });
      const code = s.replace(/^#/, '').toUpperCase();
      const like = '%' + nameKey(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      return send(res, 200, { ok: true, list: await listOut("WHERE g.name_key LIKE $1 OR g.code = $2 ORDER BY g.id DESC LIMIT 20", [like, code]) });
    }
    const mem = await memberRow(u.id);
    if (k === 'create') {
      if (mem) return fail(res, 400, 'in', '이미 길드에 들어가 있어요');
      const left = await cdLeft(u.id); if (left) return fail(res, 400, 'cd', cdMsg(left));
      if (!rate('gdc:' + u.id, 5, 3600 * 1000)) return fail(res, 429, 'rate', '길드를 너무 자주 만들었어요');
      const name = clean(b.name, 10), len = Array.from(name).length;
      if (len < 2) return fail(res, 400, 'name', '길드 이름은 2~10자예요');
      if (badHas(name) || isGhost(name) || /제작자|운영자|관리자|운영진/.test(nameKey(name))) return fail(res, 400, 'name', '이 이름은 쓸 수 없어요');
      const descr = clean(b.descr, DESC_MAX); if (badHas(descr)) return fail(res, 400, 'descr', '소개에 쓸 수 없는 말이 있어요');
      const jm = [0, 1, 2].indexOf(b.join | 0) >= 0 ? b.join | 0 : 0, minT = MIN_TR.indexOf(b.minT | 0) >= 0 ? b.minT | 0 : 0, emb = embClean(b.emb, 1);
      let g;
      try { g = (await q('INSERT INTO guilds (name, name_key, code, descr, emb, join_mode, min_tr) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [name, nameKey(name), await newCode(), descr, emb, jm, minT])).rows[0]; }
      catch (e) { if (e && e.code === '23505') return fail(res, 409, 'name', '이미 있는 길드 이름이에요'); throw e; }
      try { await q('INSERT INTO guild_members (user_id, guild_id, role, tr) VALUES ($1, $2, 2, $3)', [u.id, g.id, vTr(b.tr)]); }
      catch (e) { await q('DELETE FROM guilds WHERE id = $1', [g.id]); if (e && e.code === '23505') return fail(res, 400, 'in', '이미 길드에 들어가 있어요'); throw e; }
      await q('DELETE FROM guild_apps WHERE user_id = $1', [u.id]);
      setGid(u.id, g.id); await sys(g.id, { s: 'make', a: u.nick });
      return send(res, 200, Object.assign(await meOut(u), { made: true }));
    }
    if (k === 'join' || k === 'joincode') {
      if (mem) return fail(res, 400, 'in', '이미 길드에 들어가 있어요');
      const left = await cdLeft(u.id); if (left) return fail(res, 400, 'cd', cdMsg(left));
      const g = k === 'join' ? await guildRow(b.id | 0) : (await q('SELECT * FROM guilds WHERE code = $1', [String(b.code || '').replace(/^#/, '').toUpperCase().slice(0, 8)])).rows[0];
      if (!g) return fail(res, 404, 'nf', k === 'join' ? '없어진 길드예요' : '그런 코드의 길드가 없어요');
      const n = (await q('SELECT count(*)::int AS n FROM guild_members WHERE guild_id = $1', [g.id])).rows[0].n;
      if (n >= MAX_MEMBERS) return fail(res, 400, 'full', '길드가 가득 찼어요');
      const tr = vTr(b.tr); if (!trOk(g, tr)) return fail(res, 400, 'tr', '트로피 ' + g.min_tr + '개 이상만 들어갈 수 있어요');
      if (g.join_mode === 2 && k === 'join') return fail(res, 400, 'inv', '초대 코드로만 들어갈 수 있는 길드예요');
      if (g.join_mode === 1) {   /* 승인 가입: 신청만 남기고 간부에게 알린다 */
        const cnt = (await q('SELECT count(*)::int AS n FROM guild_apps WHERE user_id = $1', [u.id])).rows[0].n;
        if (cnt >= 5) return fail(res, 400, 'apps', '가입 신청은 한 번에 5곳까지예요');
        await q('INSERT INTO guild_apps (guild_id, user_id, tr) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO UPDATE SET tr = EXCLUDED.tr', [g.id, u.id, tr]);
        if (hook.pushGid) hook.pushGid(g.id, { t: 'g', k: 'app' });
        return send(res, 200, Object.assign(await meOut(u), { applied: g.id }));
      }
      const e = await enter(u.id, u.nick, g.id, tr);
      if (e === 'full') return fail(res, 400, 'full', '길드가 가득 찼어요');
      if (e === 'already') return fail(res, 400, 'in', '이미 길드에 들어가 있어요');
      return send(res, 200, Object.assign(await meOut(u), { joined: true }));
    }
    if (k === 'cancelapp') { await q('DELETE FROM guild_apps WHERE user_id = $1 AND guild_id = $2', [u.id, b.id | 0]); return send(res, 200, await meOut(u)); }
    if (!mem) { setGid(u.id, 0); return fail(res, 400, 'noguild', '길드에 들어가 있지 않아요'); }
    const gid = mem.guild_id, role = mem.role;
    const target = async () => { const t = await memberRow(b.u | 0); return t && t.guild_id === gid ? Object.assign(t, { nick: (await q('SELECT nick FROM users WHERE id = $1', [t.user_id])).rows[0].nick }) : null; };
    switch (k) {
      case 'accept': case 'reject': {
        if (role < 1) return fail(res, 403, 'role', '간부만 할 수 있어요');
        const a = (await q('SELECT a.*, u.nick FROM guild_apps a JOIN users u ON u.id = a.user_id WHERE a.guild_id = $1 AND a.user_id = $2', [gid, b.u | 0])).rows[0];
        if (!a) return fail(res, 404, 'nf', '이미 처리된 신청이에요');
        await q('DELETE FROM guild_apps WHERE guild_id = $1 AND user_id = $2', [gid, a.user_id]);
        if (k === 'accept') {
          if (await memberRow(a.user_id)) { upd(gid); return fail(res, 400, 'in', '그 사람은 이미 다른 길드에 들어갔어요'); }
          if (await cdLeft(a.user_id)) { upd(gid); return fail(res, 400, 'cd', '그 사람은 길드에서 나온 지 12시간이 안 됐어요'); }
          const e = await enter(a.user_id, a.nick, gid, a.tr);
          if (e === 'full') return fail(res, 400, 'full', '길드가 가득 찼어요');
          if (hook.pushUid) hook.pushUid(a.user_id, { t: 'g', k: 'in' });
        } else upd(gid);
        return send(res, 200, await meOut(u));
      }
      case 'leave': {
        const list = await members(gid);
        await q('DELETE FROM guild_members WHERE user_id = $1', [u.id]);
        const rest = list.filter((m) => m.user_id !== u.id);
        if (!rest.length) { await q('DELETE FROM guilds WHERE id = $1', [gid]); await leaveOut(u.id, gid); return send(res, 200, Object.assign(await meOut(u), { gone: true })); }
        await sys(gid, { s: 'leave', a: u.nick });
        if (role === 2) await fixLeader(gid, rest);
        upd(gid); await leaveOut(u.id, gid);
        return send(res, 200, await meOut(u));
      }
      case 'kick': {
        const t = await target(); if (!t || t.user_id === u.id) return fail(res, 404, 'nf', '길드원을 찾지 못했어요');
        if (!(role === 2 || (role === 1 && t.role === 0))) return fail(res, 403, 'role', role === 1 ? '부길드장은 멤버만 추방할 수 있어요' : '간부만 할 수 있어요');
        await q('DELETE FROM guild_members WHERE user_id = $1 AND guild_id = $2', [t.user_id, gid]);
        await sys(gid, { s: 'kick', a: t.nick, b: u.nick }); upd(gid);
        setGid(t.user_id, 0); await cdSet(t.user_id); if (hook.pushUid) hook.pushUid(t.user_id, { t: 'g', k: 'out', why: 'kick' });
        return send(res, 200, await meOut(u));
      }
      case 'role': {
        if (role !== 2) return fail(res, 403, 'role', '길드장만 할 수 있어요');
        const t = await target(); if (!t || t.user_id === u.id) return fail(res, 404, 'nf', '길드원을 찾지 못했어요');
        const r = b.r === 1 ? 1 : 0; if (t.role === r) return send(res, 200, await meOut(u));
        await q('UPDATE guild_members SET role = $2 WHERE user_id = $1', [t.user_id, r]);
        await sys(gid, { s: r ? 'sub' : 'unsub', a: t.nick }); upd(gid);
        return send(res, 200, await meOut(u));
      }
      case 'transfer': {
        if (role !== 2) return fail(res, 403, 'role', '길드장만 할 수 있어요');
        const t = await target(); if (!t || t.user_id === u.id) return fail(res, 404, 'nf', '길드원을 찾지 못했어요');
        await q('UPDATE guild_members SET role = 1 WHERE user_id = $1', [u.id]);
        await q('UPDATE guild_members SET role = 2 WHERE user_id = $1', [t.user_id]);
        await sys(gid, { s: 'lead', a: t.nick, b: u.nick }); upd(gid);
        return send(res, 200, await meOut(u));
      }
      case 'edit': {
        if (role < 1) return fail(res, 403, 'role', '간부만 할 수 있어요');
        const set = [], vals = [gid];
        if (b.notice !== undefined) { const t = clean(b.notice, NOTICE_MAX); if (badHas(t)) return fail(res, 400, 'notice', '공지에 쓸 수 없는 말이 있어요'); vals.push(t); set.push('notice = $' + vals.length); }
        if (role === 2) {
          if (b.descr !== undefined) { const t = clean(b.descr, DESC_MAX); if (badHas(t)) return fail(res, 400, 'descr', '소개에 쓸 수 없는 말이 있어요'); vals.push(t); set.push('descr = $' + vals.length); }
          if (b.emb !== undefined) { const g = await guildRow(gid); vals.push(embClean(b.emb, lvOf(g.xp))); set.push('emb = $' + vals.length); }
          if (b.join !== undefined && [0, 1, 2].indexOf(b.join | 0) >= 0) { vals.push(b.join | 0); set.push('join_mode = $' + vals.length); }
          if (b.minT !== undefined && MIN_TR.indexOf(b.minT | 0) >= 0) { vals.push(b.minT | 0); set.push('min_tr = $' + vals.length); }
        } else if (b.descr !== undefined || b.emb !== undefined || b.join !== undefined || b.minT !== undefined) return fail(res, 403, 'role', '길드 설정은 길드장만 바꿀 수 있어요');
        if (set.length) { await q('UPDATE guilds SET ' + set.join(', ') + ' WHERE id = $1', vals); if (b.notice !== undefined) await sys(gid, { s: 'notice', a: u.nick }); upd(gid); }
        return send(res, 200, await meOut(u));
      }
      case 'chat': {
        if (!rate('gdm:' + u.id, 1, 1500) || !rate('gdm2:' + u.id, 20, 60000)) return fail(res, 429, 'rate', '너무 빨리 보내고 있어요');
        if (b.e !== undefined) { const e = b.e | 0; if (e < 0 || e >= EMOTES) return fail(res, 400, 'e', '없는 이모트예요'); return send(res, 200, { ok: true, m: await addMsg(gid, u, 'e', { e }) }); }
        const t = clean(b.t, MSG_MAX); if (!t) return fail(res, 400, 't', '메시지를 입력해 주세요');
        return send(res, 200, { ok: true, m: await addMsg(gid, u, 't', { t: badMask(t) }) });
      }
      case 'brag': {   /* 자랑 카드: 신화 이상 새 캐릭터 · 진보스 Extreme 첫 격파 (게임이 알아서 보냄) */
        if (!rate('gdb:' + u.id, 12, 3600 * 1000)) return send(res, 200, { ok: true });
        let body;
        if (b.kind === 'chr' && /^[a-z0-9_]{1,24}$/.test(String(b.ty || '')) && (b.g | 0) >= 4 && (b.g | 0) <= 6) body = { kind: 'chr', ty: String(b.ty), g: b.g | 0, cl: [] };
        else if (b.kind === 'jb' && (b.bi | 0) >= 0 && (b.bi | 0) < 64) body = { kind: 'jb', bi: b.bi | 0, cl: [] };
        else return fail(res, 400, 'brag', '잘못된 요청이에요');
        return send(res, 200, { ok: true, m: await addMsg(gid, u, 'b', body) });
      }
      case 'clap': {   /* 자랑 카드에 박수 (누르면 켜고 · 다시 누르면 끔) */
        const r = (await q("SELECT * FROM guild_msgs WHERE id = $1 AND guild_id = $2 AND k = 'b'", [Math.floor(+b.i) || 0, gid])).rows[0];
        if (!r) return fail(res, 404, 'nf', '없어진 메시지예요');
        const cl = Array.isArray(r.body.cl) ? r.body.cl.slice() : [], at = cl.indexOf(u.id);
        if (at >= 0) cl.splice(at, 1); else if (cl.length < MAX_MEMBERS) cl.push(u.id);
        r.body.cl = cl; await q('UPDATE guild_msgs SET body = $2 WHERE id = $1', [r.id, r.body]);
        const m = msgOut(r); if (hook.pushGid) hook.pushGid(gid, { t: 'g', k: 'msgup', m });
        return send(res, 200, { ok: true, m });
      }
      case 'more': {
        const before = Math.floor(+b.before) || 0;
        const rows = (await q('SELECT * FROM guild_msgs WHERE guild_id = $1 AND id < $2 ORDER BY id DESC LIMIT 50', [gid, before])).rows.reverse().map(msgOut);
        return send(res, 200, { ok: true, msgs: rows });
      }
      case 'report': {
        const r = (await q('SELECT * FROM guild_msgs WHERE id = $1 AND guild_id = $2', [Math.floor(+b.i) || 0, gid])).rows[0];
        if (!r || !r.user_id || r.user_id === u.id) return fail(res, 404, 'nf', '신고할 수 없는 메시지예요');
        if (!rate('gdr:' + u.id, 20, 3600 * 1000)) return fail(res, 429, 'rate', '신고를 너무 많이 했어요');
        const txt = r.k === 't' ? String(r.body.t || '') : r.k === 'e' ? '(이모트)' : '(카드)';
        await q('INSERT INTO guild_reports (msg_id, guild_id, reporter, target, txt) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (msg_id, reporter) DO NOTHING', [r.id, gid, u.id, r.user_id, txt.slice(0, 200)]);
        return send(res, 200, { ok: true });
      }
      case 'watch': {   /* 길드원 관전: 대전 중이면 방 코드, 진보스전 중이면 접속 번호 */
        const t = await target(); if (!t || t.user_id === u.id) return fail(res, 404, 'nf', '길드원을 찾지 못했어요');
        const code = hook.roomOf ? hook.roomOf(t.user_id) : null; if (code) return send(res, 200, { ok: true, code });
        const p = hook.presOf ? hook.presOf(t.user_id) : null; if (p && p.ps === 'jb' && p.pid) return send(res, 200, { ok: true, pid: p.pid });
        return fail(res, 404, 'none', '지금은 볼 수 있는 판이 없어요');
      }
    }
    return fail(res, 400, 'gd', '알 수 없는 요청이에요');
  };

  /* 친선전 카드: 게임이 숨김 방을 만들 때(gd:1) 서버가 바로 채팅에 올린다. 방 상태가 바뀌면 카드도 바꿔 알린다 */
  G.duelPost = async function duelPost(u, code, mode) {
    const gid = G.gidOf(u.id); if (!gid) return 0;
    try { const m = await addMsg(gid, u, 'd', { code, md: mode }); duelMap.set(code, { gid, mid: m.i }); return gid; } catch (e) { return 0; }
  };
  G.duelPing = function duelPing(code) {
    const d = duelMap.get(code); if (!d) return;
    q('SELECT * FROM guild_msgs WHERE id = $1', [d.mid]).then((r) => { const row = r.rows[0]; if (!row) { duelMap.delete(code); return; } const m = msgOut(row); if (m.b.st === 'end') duelMap.delete(code); if (hook.pushGid) hook.pushGid(d.gid, { t: 'g', k: 'msgup', m }); }).catch(() => {});
  };

  /* ── 제작자 도구 ── */
  async function ownReq(u, k, b, res) {
    if (!u.owner) return fail(res, 403, 'owner', '제작자 계정만 쓸 수 있어요');
    if (k === 'own.list') {
      const r = await q("SELECT g.id, g.name, g.code, g.created_at, (SELECT count(*) FROM guild_members m WHERE m.guild_id = g.id)::int AS n, (SELECT u.nick FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = g.id AND m.role = 2 LIMIT 1) AS lead, (SELECT count(*) FROM guild_reports x WHERE x.guild_id = g.id)::int AS rp FROM guilds g ORDER BY g.id DESC LIMIT 200");
      const rp = await q('SELECT r.id, r.msg_id, r.guild_id, r.txt, r.at, a.nick AS rn, t.nick AS tn, g.name AS gn FROM guild_reports r LEFT JOIN users a ON a.id = r.reporter LEFT JOIN users t ON t.id = r.target LEFT JOIN guilds g ON g.id = r.guild_id ORDER BY r.id DESC LIMIT 60');
      return send(res, 200, { ok: true, list: r.rows.map((g) => ({ id: g.id, name: g.name, code: g.code, n: g.n, lead: g.lead || '', rp: g.rp, at: ms(g.created_at) })), reports: rp.rows.map((x) => ({ id: +x.id, mid: +x.msg_id, gid: x.guild_id, gn: x.gn || '(해산됨)', txt: x.txt, rn: x.rn || '?', tn: x.tn || '?', at: ms(x.at) })) });
    }
    if (k === 'own.del') {
      const gid = b.id | 0, list = await members(gid);
      await q('DELETE FROM guilds WHERE id = $1', [gid]);
      list.forEach((m) => { setGid(m.user_id, 0); if (hook.pushUid) hook.pushUid(m.user_id, { t: 'g', k: 'out', why: 'del' }); });
      return send(res, 200, { ok: true });
    }
    if (k === 'own.msgdel') {
      const r = (await q('DELETE FROM guild_msgs WHERE id = $1 RETURNING guild_id', [Math.floor(+b.mid) || 0])).rows[0];
      await q('DELETE FROM guild_reports WHERE msg_id = $1', [Math.floor(+b.mid) || 0]);
      if (r && hook.pushGid) hook.pushGid(r.guild_id, { t: 'g', k: 'msgdel', i: Math.floor(+b.mid) });
      return send(res, 200, { ok: true });
    }
    if (k === 'own.repdel') { await q('DELETE FROM guild_reports WHERE id = $1', [Math.floor(+b.id) || 0]); return send(res, 200, { ok: true }); }
    return fail(res, 400, 'own', '알 수 없는 요청이에요');
  }

  G.helpers = { badHas, badMask, nameKey };
  return G;
};
