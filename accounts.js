'use strict';
/* 스핀 클래시 계정 모듈
 * - 아이디/비밀번호 가입·로그인, 세션 토큰, 닉네임(중복 불가), 선택 이메일(인증 후 비밀번호 재설정용)
 * - DB는 Postgres (환경변수 DATABASE_URL). 없거나 연결 실패하면 계정 기능만 꺼지고 게임은 손님으로 계속 된다.
 * - 환경변수: DATABASE_URL, OWNER_USERNAME(제작자 아이디), BASE_URL(메일 링크 주소),
 *   메일: MAIL_PROVIDER=brevo|resend|file, BREVO_API_KEY / RESEND_API_KEY, MAIL_FROM, MAIL_FROM_NAME, MAIL_FILE(테스트용)
 */
const crypto = require('crypto');
const fs = require('fs');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const env = process.env;
const SESSION_DAYS = 30, MAX_SESSIONS = 10;
const RESERVED_USER = new Set(['admin', 'administrator', 'root', 'system', 'command', 'nocommand', 'owner', 'guest', 'support', 'staff', 'moderator', 'spinclash', 'master']);
const BAD_PW = new Set(['12345678', '123456789', '1234567890', '11111111', '00000000', 'password', 'password1', 'qwertyui', 'asdfghjk', 'abcd1234', '12341234', 'iloveyou', '87654321']);
const INVIS = /[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

function normKey(s) { return String(s == null ? '' : s).normalize('NFKC').replace(INVIS, '').toLowerCase(); }
function cleanNick(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 10).join('').trim();
}
/* 쿠폰으로 열리는 권한: rA=일반~전설 캐릭터·재능·스펠 전부 · rB=태고 전부. 코드는 환경변수 COUPON_CODES 에만 있다
 * 형식: 코드=권한,코드=권한 …  예) spinclash=rA,beta30=rB  (코드 앞에 no 를 붙이면 자동으로 반대: nospinclash = rA 회수. 권한 앞에 -를 붙인 코드도 회수용)
 * cmd=제작자 권한(닉네임 "유령")은 쿠폰으로는 더 못 얻는다: 제작자 계정(OWNER_USERNAME)에만 자동으로 붙는다. 예전 r4·r5·r6·cmd 코드는 모두 무효 */
const GRANTS = new Set(['rA', 'rB']);                  // 쿠폰으로 얻을 수 있는 권한
const GRANTS_ALL = new Set(['rA', 'rB', 'cmd']);       // 계정에 저장될 수 있는 권한
function parseCoupons(str) {
  const m = new Map();
  String(str || '').split(',').forEach((part) => {
    const i = part.indexOf('='); if (i < 1) return;
    const code = part.slice(0, i).trim().toLowerCase(); let g = part.slice(i + 1).trim(); const rev = g.charAt(0) === '-'; if (rev) g = g.slice(1);
    if (code && code.length <= 40 && GRANTS.has(g)) m.set(code, { g, rev });
  });
  return m;
}
function grantList(u) {
  const a = String(u.grants || '').split(',').filter((x) => GRANTS_ALL.has(x));
  if (u.owner && a.indexOf('cmd') < 0) a.push('cmd');
  return a;
}
function isGhost(s) { return normKey(s).search(/유[유우]*령/) >= 0; }
function maskEmail(e) { if (!e) return ''; const [a, d] = e.split('@'); return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '***') + '@' + d; }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = function createAccounts() {
  const A = { enabled: false, mailOn: false, state: 'off' };
  let pool = null;
  const nickKeys = new Map();   // nick_key → user id (손님이 등록된 닉네임을 못 쓰게)

  /* ── DB ── */
  async function q(text, values) { return pool.query(text, values || []); }
  const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  nick TEXT NOT NULL,
  nick_key TEXT NOT NULL,
  email TEXT,
  email_key TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_key_uq ON users (nick_key);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_verified_uq ON users (email_key) WHERE email_verified;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  email_key TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS user_tokens_user_idx ON user_tokens (user_id, kind);
ALTER TABLE users ADD COLUMN IF NOT EXISTS grants TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`;

  /* 쿠폰 초기화: COUPON_RESET_ID 를 새 값으로 바꿔서 배포하면, 서버가 켜질 때 모든 계정의 쿠폰 권한(grants)을 한 번만 비운다.
   * 제작자 권한을 잃은 일반 계정의 "유령" 닉네임도 쿠폰 해제 때처럼 '플레이어####' 로 바꾼다. 제작자 계정(OWNER_USERNAME)은 쿠폰이 아니라서 그대로.
   * 끝까지 성공해야 기록을 남기므로, 도중에 실패하면 다음 시작 때 다시 한다. 게임 쪽(index.html)의 같은 이름 값도 같이 올릴 것 */
  const COUPON_RESET_ID = 'c3';
  async function couponResetOnce() {
    const done = await q("SELECT v FROM app_meta WHERE k = 'coupon_reset'");
    if (done.rows[0] && done.rows[0].v === COUPON_RESET_ID) return;
    const r = await q("UPDATE users SET grants = '' WHERE grants <> '' RETURNING id");
    const g = await q('SELECT id, nick FROM users WHERE is_owner = false');
    let renamed = 0;
    for (const row of g.rows) {
      if (!isGhost(row.nick)) continue;
      for (let i = 0; i < 20; i++) {
        const nn = '플레이어' + (1000 + crypto.randomInt(9000));
        try { await q('UPDATE users SET nick = $1, nick_key = $2 WHERE id = $3 RETURNING 1', [nn, normKey(nn), row.id]); nickKeys.delete(normKey(row.nick)); nickKeys.set(normKey(nn), 1); renamed++; break; }
        catch (e) { if (!isUniq(e, 'nick')) throw e; }
      }
    }
    await q("INSERT INTO app_meta (k, v) VALUES ('coupon_reset', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [COUPON_RESET_ID]);
    console.log('[accounts] 쿠폰 초기화(' + COUPON_RESET_ID + '): 권한 비운 계정 ' + r.rowCount + '명 · 유령 닉네임 변경 ' + renamed + '명');
  }

  A.init = async function init() {
    if (!env.DATABASE_URL) { console.log('[accounts] 꺼짐: DATABASE_URL 이 없어요 (손님 모드만 동작)'); return; }
    let Pool;
    try { Pool = require('pg').Pool; } catch (e) { console.log('[accounts] 꺼짐: pg 모듈을 못 찾았어요 (npm install 필요)'); A.state = 'err'; return; }
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    pool.on('error', (e) => console.log('[accounts] DB 연결 오류:', e.message));
    let lastErr = null;
    for (let i = 0; i < 4 && !A.enabled; i++) {   // 무료 DB는 잠들어 있을 수 있어서 몇 번 다시 시도
      try {
        await q(SCHEMA);
        const r = await q('SELECT nick_key FROM users');
        r.rows.forEach((x) => nickKeys.set(x.nick_key, 1));
        await couponResetOnce();
        A.enabled = true; A.state = 'ok';
      } catch (e) { lastErr = e; console.log('[accounts] DB 준비 실패 (' + (i + 1) + '/4):', e.message); await new Promise((r) => setTimeout(r, 3000)); }
    }
    if (!A.enabled) { A.state = 'err'; console.log('[accounts] 꺼짐: DB에 연결하지 못했어요 –', lastErr && lastErr.message); return; }
    const prov = mailProvider(); A.mailOn = !!prov;
    console.log('[accounts] 켜짐 · 가입자 ' + nickKeys.size + '명 · 메일 ' + (prov || '꺼짐') + (env.OWNER_USERNAME ? ' · 제작자 아이디 설정됨' : ''));
    const t = setInterval(() => { q('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}); q('DELETE FROM user_tokens WHERE expires_at < now()').catch(() => {}); }, 30 * 60 * 1000); t.unref();
  };
  A.nickTaken = (nick) => nickKeys.has(normKey(nick));

  /* ── 속도 제한 (메모리) ── */
  const hits = new Map();
  function rate(key, max, windowMs) {
    const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr); return true;
  }
  function rateLeft(key, max, windowMs) { const now = Date.now(); const arr = (hits.get(key) || []).filter((t) => now - t < windowMs); return arr.length < max; }
  setInterval(() => { const now = Date.now(); hits.forEach((arr, k) => { const f = arr.filter((t) => now - t < 3600 * 1000); if (f.length) hits.set(k, f); else hits.delete(k); }); }, 10 * 60 * 1000).unref();

  /* ── 비밀번호 ── */
  let hashing = 0; const hq = [];
  function limited(fn) {   // 해시 계산은 CPU를 많이 써서 동시에 2개까지만
    return new Promise((resolve, reject) => {
      const run = () => { hashing++; fn().then(resolve, reject).finally(() => { hashing--; const n = hq.shift(); if (n) n(); }); };
      if (hashing < 2) run(); else if (hq.length < 40) hq.push(run); else reject(Object.assign(new Error('busy'), { busy: true }));
    });
  }
  const SC = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  async function hashPw(pw) { const salt = crypto.randomBytes(16); const key = await scrypt(pw.normalize('NFKC'), salt, 32, SC); return 's1$' + salt.toString('hex') + '$' + key.toString('hex'); }
  async function checkPw(pw, stored) {
    const p = String(stored || '').split('$'); if (p.length !== 3 || p[0] !== 's1') return false;
    const salt = Buffer.from(p[1], 'hex'), want = Buffer.from(p[2], 'hex');
    const key = await scrypt(String(pw).normalize('NFKC'), salt, 32, SC);
    return key.length === want.length && crypto.timingSafeEqual(key, want);
  }
  let dummy = null;
  async function dummyCheck(pw) { if (!dummy) dummy = await hashPw('dummy-password'); await checkPw(pw, dummy); }

  /* ── 검증 ── */
  function vUser(u) {
    u = String(u == null ? '' : u).trim().toLowerCase();
    if (!/^[a-z0-9_]{4,16}$/.test(u)) return { err: '아이디는 영문 소문자·숫자·밑줄(_) 4~16자예요' };
    if (RESERVED_USER.has(u)) return { err: '쓸 수 없는 아이디예요' };
    return { v: u };
  }
  function vPw(p, u) {
    p = String(p == null ? '' : p);
    if (p.length < 8 || p.length > 64) return { err: '비밀번호는 8~64자예요' };
    if (!p.trim()) return { err: '비밀번호를 입력해 주세요' };
    if (BAD_PW.has(p.toLowerCase()) || (u && p.toLowerCase() === u)) return { err: '너무 쉬운 비밀번호예요' };
    return { v: p };
  }
  function vNick(n, owner, ghost) {
    n = cleanNick(n); const len = Array.from(n).length;
    if (len < 2) return { err: '닉네임은 2~10자예요' };
    if (isGhost(n) && !owner && !ghost) return { err: '이 닉네임은 쓸 수 없어요' };
    if (!owner && /제작자|운영자|관리자/.test(normKey(n))) return { err: '이 닉네임은 쓸 수 없어요' };
    if (/^손님\d*$/.test(n)) return { err: '"손님"으로 시작하는 숫자 닉네임은 손님 전용이에요' };
    return { v: n };
  }
  function vEmail(e) {
    e = String(e == null ? '' : e).trim();
    if (e.length > 100 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { err: '이메일 형식이 맞지 않아요' };
    return { v: e, k: e.toLowerCase() };
  }
  const isOwnerName = (u) => !!env.OWNER_USERNAME && env.OWNER_USERNAME.trim().toLowerCase() === u;

  /* ── 세션 ── */
  async function newSession(uid) {
    const tk = crypto.randomBytes(32).toString('base64url');
    await q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '" + SESSION_DAYS + " days')", [sha(tk), uid]);
    await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ' + MAX_SESSIONS + ') RETURNING 1', [uid]);
    return tk;
  }
  const USER_COLS = 'u.id, u.username, u.nick, u.is_owner, u.email, u.email_verified, u.grants';
  async function userFromToken(tk) {
    if (!A.enabled || typeof tk !== 'string' || tk.length < 20 || tk.length > 80) return null;
    const r = await q('SELECT ' + USER_COLS + ' FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha(tk)]);
    return r.rows[0] ? { id: r.rows[0].id, username: r.rows[0].username, nick: r.rows[0].nick, owner: !!r.rows[0].is_owner, email: r.rows[0].email, ev: !!r.rows[0].email_verified, grants: r.rows[0].grants || '' } : null;
  }
  A.userFromToken = (tk) => userFromToken(tk).catch(() => null);
  const me = (u) => ({ u: u.username, n: u.nick, e: maskEmail(u.email), ev: !!u.ev, o: !!u.owner, g: grantList(u) });

  /* ── 메일 ── */
  function mailProvider() { return env.MAIL_PROVIDER || (env.BREVO_API_KEY ? 'brevo' : (env.RESEND_API_KEY ? 'resend' : (env.MAIL_FILE ? 'file' : ''))); }
  async function sendMail(to, subject, text) {
    const prov = mailProvider(); const from = env.MAIL_FROM || '', name = env.MAIL_FROM_NAME || '스핀 클래시';
    if (prov === 'file') { fs.appendFileSync(env.MAIL_FILE, JSON.stringify({ to, subject, text }) + '\n'); return; }
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 10000);
    try {
      let r;
      if (prov === 'brevo') r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: ac.signal, headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name, email: from }, to: [{ email: to }], subject, textContent: text }) });
      else if (prov === 'resend') r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ac.signal, headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: name + ' <' + from + '>', to: [to], subject, text }) });
      else throw new Error('mail off');
      if (!r.ok) throw new Error('mail http ' + r.status);
    } finally { clearTimeout(tm); }
  }
  function baseUrl(req) { return (env.BASE_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() + '://' + req.headers.host)).replace(/\/$/, ''); }
  async function makeToken(uid, kind, emailKey, minutes) {
    const raw = crypto.randomBytes(32).toString('base64url');
    await q('DELETE FROM user_tokens WHERE user_id = $1 AND kind = $2 RETURNING 1', [uid, kind]);
    await q("INSERT INTO user_tokens (token_hash, user_id, kind, email_key, expires_at) VALUES ($1, $2, $3, $4, now() + interval '" + (minutes | 0) + " minutes')", [sha(raw), uid, kind, emailKey || null]);
    return raw;
  }

  /* ── HTTP ── */
  const ip = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
  const fail = (res, code, c, m) => send(res, code, { ok: false, c, m });
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const ch = [];
      req.on('data', (d) => { n += d.length; if (n > 4096) { reject(Object.assign(new Error('big'), { big: true })); req.destroy(); } else ch.push(d); });
      req.on('end', () => { try { const s = Buffer.concat(ch).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(Object.assign(new Error('json'), { json: true })); } });
      req.on('error', reject);
    });
  }
  const bearer = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
  function page(res, ok, msg) {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>스핀 클래시</title><body style="font-family:sans-serif;text-align:center;padding:48px 20px;background:#fbf6ea;color:#1c1712"><h2>' + (ok ? '✅ ' : '⚠️ ') + msg + '</h2><p><a href="/">게임으로 돌아가기</a></p></body>');
  }
  const isUniq = (e, name) => e && e.code === '23505' && (!name || String(e.constraint || e.message || '').indexOf(name) >= 0);

  /* ── 공지(홈 화면 배너): 제작자 계정만 쓰고, 모두가 읽는다. app_meta 의 'notice' 에 JSON {t, at} 로 저장 ── */
  const NOTICE_MAX = 200;
  let noticeCache = null, noticeAt = 0;
  async function noticeGet() {
    if (noticeCache && Date.now() - noticeAt < 15000) return noticeCache;
    const r = await q("SELECT v FROM app_meta WHERE k = 'notice'");
    let v = { t: '', at: 0 };
    if (r.rows[0]) { try { const j = JSON.parse(r.rows[0].v); if (j && typeof j.t === 'string') v = { t: j.t, at: +j.at || 0 }; } catch (e) {} }
    noticeCache = v; noticeAt = Date.now(); return v;
  }
  async function noticeSet(u, b, res) {
    if (!u.owner) return fail(res, 403, 'owner', '제작자 계정만 쓸 수 있어요');
    const t = Array.from(String(b && b.t != null ? b.t : '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, NOTICE_MAX).join('');
    const v = { t, at: t ? Date.now() : 0 };
    await q("INSERT INTO app_meta (k, v) VALUES ('notice', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [JSON.stringify(v)]);
    noticeCache = v; noticeAt = Date.now();
    send(res, 200, { ok: true, t: v.t, at: v.at });
  }

  A.handle = async function handle(req, res) {
    const url = new URL(req.url, 'http://x'); const p = url.pathname;
    if (p.indexOf('/api/') !== 0) return false;
    try {
      if (!A.enabled) { fail(res, 503, 'off', '계정 기능이 아직 꺼져 있어요'); return true; }
      if (req.method === 'GET' && p === '/api/email/verify') { await emailVerify(url, res); return true; }
      if (req.method === 'GET' && p === '/api/me') { const u = await userFromToken(bearer(req)); if (!u) fail(res, 401, 'auth', '로그인이 필요해요'); else send(res, 200, { ok: true, me: me(u), mail: A.mailOn }); return true; }
      if (req.method === 'GET' && p === '/api/notice') { const n = await noticeGet(); send(res, 200, { ok: true, t: n.t, at: n.at }); return true; }
      if (req.method !== 'POST') { fail(res, 405, 'method', '잘못된 요청이에요'); return true; }
      const b = await readBody(req); const addr = ip(req);
      switch (p) {
        case '/api/register': return await register(b, addr, res), true;
        case '/api/login': return await login(b, addr, res), true;
        case '/api/reset': return await resetReq(b, addr, req, res), true;
        case '/api/reset/confirm': return await resetConfirm(b, addr, res), true;
      }
      const u = await userFromToken(bearer(req)); if (!u) { fail(res, 401, 'auth', '로그인이 필요해요'); return true; }
      switch (p) {
        case '/api/logout': await q('DELETE FROM sessions WHERE token_hash = $1 RETURNING 1', [sha(bearer(req))]); send(res, 200, { ok: true }); return true;
        case '/api/notice': await noticeSet(u, b, res); return true;
        case '/api/nick': await setNick(u, b, res); return true;
        case '/api/coupon': await redeem(u, b, addr, res); return true;
        case '/api/pw': await setPw(u, b, req, res); return true;
        case '/api/email': await setEmail(u, b, req, res); return true;
        case '/api/delete': await delAccount(u, b, res); return true;
      }
      fail(res, 404, 'nf', '없는 요청이에요'); return true;
    } catch (e) {
      if (e && e.big) fail(res, 413, 'big', '요청이 너무 커요');
      else if (e && e.json) fail(res, 400, 'json', '잘못된 요청이에요');
      else if (e && e.busy) fail(res, 503, 'busy', '잠시 후 다시 시도해 주세요');
      else { console.log('[accounts] 오류:', e && e.message); if (!res.headersSent) fail(res, 500, 'err', '서버 오류예요. 잠시 후 다시 시도해 주세요'); }
      return true;
    }
  };

  async function register(b, addr, res) {
    const u = vUser(b.u); if (u.err) return fail(res, 400, 'user', u.err);
    const pw = vPw(b.p, u.v); if (pw.err) return fail(res, 400, 'pw', pw.err);
    const owner = isOwnerName(u.v);
    const n = vNick(b.n, owner); if (n.err) return fail(res, 400, 'nick', n.err);
    if (!rate('reg:' + addr, +env.REG_PER_HOUR || 5, 3600 * 1000)) return fail(res, 429, 'rate', '가입을 너무 많이 시도했어요. 잠시 후 다시 해 주세요');
    const h = await limited(() => hashPw(pw.v));
    let row;
    try { row = (await q('INSERT INTO users (username, pw_hash, nick, nick_key, is_owner) VALUES ($1, $2, $3, $4, $5) RETURNING id', [u.v, h, n.v, normKey(n.v), owner])).rows[0]; }
    catch (e) {
      if (isUniq(e, 'username')) return fail(res, 409, 'user', '이미 있는 아이디예요');
      if (isUniq(e, 'nick')) return fail(res, 409, 'nick', '이미 있는 닉네임이에요');
      throw e;
    }
    nickKeys.set(normKey(n.v), 1);
    const tk = await newSession(row.id);
    send(res, 200, { ok: true, tk, me: me({ username: u.v, nick: n.v, email: null, ev: false, owner, grants: '' }), mail: A.mailOn });
  }

  async function login(b, addr, res) {
    const uname = String(b.u == null ? '' : b.u).trim().toLowerCase().slice(0, 32); const pw = String(b.p == null ? '' : b.p).slice(0, 200);
    const kIp = 'lfi:' + addr, kU = 'lfu:' + uname;
    if (!rateLeft(kIp, 20, 600 * 1000) || !rateLeft(kU, 8, 600 * 1000)) return fail(res, 429, 'rate', '로그인을 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요');
    const r = await q('SELECT id, username, pw_hash, nick, is_owner, email, email_verified, grants FROM users WHERE username = $1', [uname]);
    const row = r.rows[0];
    let good = false;
    if (row) good = await limited(() => checkPw(pw, row.pw_hash)); else await limited(() => dummyCheck(pw));
    if (!good) { rate(kIp, 1e9, 600 * 1000); rate(kU, 1e9, 600 * 1000); return fail(res, 401, 'login', '아이디 또는 비밀번호가 맞지 않아요'); }
    hits.delete(kU);
    let owner = !!row.is_owner;
    if (isOwnerName(row.username) && !owner) { owner = true; await q('UPDATE users SET is_owner = TRUE WHERE id = $1 RETURNING 1', [row.id]); }
    await q('UPDATE users SET last_login = now() WHERE id = $1 RETURNING 1', [row.id]);
    const tk = await newSession(row.id);
    send(res, 200, { ok: true, tk, me: me({ username: row.username, nick: row.nick, email: row.email, ev: row.email_verified, owner, grants: row.grants || '' }), mail: A.mailOn });
  }

  async function setNick(u, b, res) {
    if (!rate('nick:' + u.id, 5, 3600 * 1000)) return fail(res, 429, 'rate', '닉네임을 너무 자주 바꿨어요. 잠시 후 다시 해 주세요');
    const n = vNick(b.n, u.owner, grantList(u).indexOf('cmd') >= 0); if (n.err) return fail(res, 400, 'nick', n.err);
    try { await q('UPDATE users SET nick = $1, nick_key = $2 WHERE id = $3 RETURNING 1', [n.v, normKey(n.v), u.id]); }
    catch (e) { if (isUniq(e, 'nick')) return fail(res, 409, 'nick', '이미 있는 닉네임이에요'); throw e; }
    nickKeys.delete(normKey(u.nick)); nickKeys.set(normKey(n.v), 1);
    send(res, 200, { ok: true, me: me(Object.assign({}, u, { nick: n.v })) });
  }

  /* 쿠폰: 코드는 서버에서만 확인하고, 결과(열린 권한)는 계정에 저장한다. 틀린 코드만 시도 횟수에 센다 */
  let couponMap = null;
  async function redeem(u, b, addr, res) {
    if (!couponMap) couponMap = parseCoupons(env.COUPON_CODES);
    if (!couponMap.size) return fail(res, 503, 'cpn', '쿠폰이 아직 준비되지 않았어요');
    const code = String(b.c == null ? '' : b.c).trim().toLowerCase().slice(0, 40);
    if (!code) return fail(res, 400, 'cpn', '코드를 입력해 주세요');
    const kU = 'cpf:' + u.id, kIp = 'cpi:' + addr;
    if (!rateLeft(kU, 10, 600 * 1000) || !rateLeft(kIp, 40, 600 * 1000)) return fail(res, 429, 'rate', '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요');
    let hit = couponMap.get(code);
    if (!hit && code.indexOf('no') === 0) {   // 코드 앞에 no 를 붙이면 반대(권한 회수): nospinclash · nobeta30
      const base = couponMap.get(code.slice(2));
      if (base && !base.rev) hit = { g: base.g, rev: true };
    }
    if (!hit) { rate(kU, 1e9, 600 * 1000); rate(kIp, 1e9, 600 * 1000); return send(res, 200, { ok: false, k: 'none', m: '없는 코드예요' }); }
    const cur = grantList({ grants: u.grants, owner: false });   // 저장된 권한만 (제작자 계정의 자동 cmd 는 따로)
    let kind, nick = u.nick;
    if (hit.rev) {
      if (cur.indexOf(hit.g) < 0) return send(res, 200, { ok: true, k: 'norev', g: hit.g, me: me(u) });
      const left = cur.filter((x) => x !== hit.g);
      await q('UPDATE users SET grants = $1 WHERE id = $2 RETURNING 1', [left.join(','), u.id]);
      u.grants = left.join(',');
      if (hit.g === 'cmd' && !u.owner && isGhost(u.nick)) {   // 제작자 권한을 잃으면 "유령" 닉네임도 바꾼다
        for (let i = 0; i < 20; i++) {
          const nn = '플레이어' + (1000 + crypto.randomInt(9000));
          try { await q('UPDATE users SET nick = $1, nick_key = $2 WHERE id = $3 RETURNING 1', [nn, normKey(nn), u.id]); nickKeys.delete(normKey(u.nick)); nickKeys.set(normKey(nn), 1); nick = nn; break; }
          catch (e) { if (!isUniq(e, 'nick')) throw e; }
        }
      }
      kind = 'revoke';
    } else {
      if (cur.indexOf(hit.g) >= 0 || (hit.g === 'cmd' && u.owner)) return send(res, 200, { ok: true, k: 'dup', g: hit.g, me: me(u) });
      cur.push(hit.g);
      await q('UPDATE users SET grants = $1 WHERE id = $2 RETURNING 1', [cur.join(','), u.id]);
      u.grants = cur.join(',');
      kind = 'grant';
    }
    send(res, 200, { ok: true, k: kind, g: hit.g, me: me(Object.assign({}, u, { nick })) });
  }

  async function verifyOwnPw(u, pw) {
    const r = await q('SELECT pw_hash FROM users WHERE id = $1', [u.id]);
    return !!r.rows[0] && await limited(() => checkPw(String(pw == null ? '' : pw).slice(0, 200), r.rows[0].pw_hash));
  }
  async function setPw(u, b, req, res) {
    if (!rate('pwc:' + u.id, 8, 3600 * 1000)) return fail(res, 429, 'rate', '너무 자주 시도했어요. 잠시 후 다시 해 주세요');
    if (!(await verifyOwnPw(u, b.o))) return fail(res, 401, 'pw', '지금 비밀번호가 맞지 않아요');
    const pw = vPw(b.p, u.username); if (pw.err) return fail(res, 400, 'pw', pw.err);
    const h = await limited(() => hashPw(pw.v));
    await q('UPDATE users SET pw_hash = $1 WHERE id = $2 RETURNING 1', [h, u.id]);
    await q('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING 1', [u.id, sha(bearer(req))]);
    send(res, 200, { ok: true });
  }

  async function setEmail(u, b, req, res) {
    if (!A.mailOn) return fail(res, 503, 'mail', '메일 서비스가 아직 준비되지 않았어요');
    if (!rate('em:' + u.id, 5, 3600 * 1000)) return fail(res, 429, 'rate', '너무 자주 시도했어요. 잠시 후 다시 해 주세요');
    if (b.resend) {   // 인증 메일 다시 보내기
      if (!u.email || u.ev) return fail(res, 400, 'email', '다시 보낼 인증 메일이 없어요');
      const raw = await makeToken(u.id, 'verify', normKey(u.email), 60);
      try { await sendMail(u.email, '[스핀 클래시] 이메일 인증', '아래 링크를 열면 이메일 인증이 끝나요 (1시간 안에).\n\n' + baseUrl(req) + '/api/email/verify?t=' + raw + '\n\n본인이 요청하지 않았다면 이 메일을 무시해도 돼요.'); }
      catch (er) { console.log('[accounts] 메일 전송 실패:', er.message); return fail(res, 502, 'mail', '메일을 보내지 못했어요. 잠시 후 다시 해 주세요'); }
      return send(res, 200, { ok: true, sent: true });
    }
    if (!(await verifyOwnPw(u, b.p))) return fail(res, 401, 'pw', '비밀번호가 맞지 않아요');
    if (b.e === '' || b.e === null) {   // 이메일 지우기
      await q('UPDATE users SET email = NULL, email_key = NULL, email_verified = FALSE WHERE id = $1 RETURNING 1', [u.id]);
      await q("DELETE FROM user_tokens WHERE user_id = $1 AND kind = 'verify' RETURNING 1", [u.id]);
      return send(res, 200, { ok: true, me: me(Object.assign({}, u, { email: null, ev: false })) });
    }
    const e = vEmail(b.e); if (e.err) return fail(res, 400, 'email', e.err);
    const taken = await q('SELECT 1 FROM users WHERE email_key = $1 AND email_verified AND id <> $2', [e.k, u.id]);
    if (taken.rows.length) return fail(res, 409, 'email', '이미 다른 계정에서 쓰는 이메일이에요');
    const raw = await makeToken(u.id, 'verify', e.k, 60);
    try { await sendMail(e.v, '[스핀 클래시] 이메일 인증', '아래 링크를 열면 이메일 인증이 끝나요 (1시간 안에).\n\n' + baseUrl(req) + '/api/email/verify?t=' + raw + '\n\n본인이 요청하지 않았다면 이 메일을 무시해도 돼요.'); }
    catch (er) { console.log('[accounts] 메일 전송 실패:', er.message); return fail(res, 502, 'mail', '메일을 보내지 못했어요. 이메일 주소를 확인하고 다시 해 주세요'); }
    await q('UPDATE users SET email = $1, email_key = $2, email_verified = FALSE WHERE id = $3 RETURNING 1', [e.v, e.k, u.id]);
    send(res, 200, { ok: true, sent: true, me: me(Object.assign({}, u, { email: e.v, ev: false })) });
  }

  async function emailVerify(url, res) {
    const t = String(url.searchParams.get('t') || '');
    if (t.length < 20 || t.length > 80) return page(res, false, '링크가 올바르지 않아요');
    const r = await q("SELECT user_id, email_key FROM user_tokens WHERE token_hash = $1 AND kind = 'verify' AND expires_at > now()", [sha(t)]);
    const row = r.rows[0]; if (!row) return page(res, false, '링크가 만료됐거나 이미 사용됐어요');
    try {
      const up = await q('UPDATE users SET email_verified = TRUE WHERE id = $1 AND email_key = $2 RETURNING id', [row.user_id, row.email_key]);
      if (!up.rows.length) return page(res, false, '등록된 이메일이 바뀌어서 이 링크는 쓸 수 없어요');
    } catch (e) { if (isUniq(e)) return page(res, false, '이미 다른 계정에서 인증된 이메일이에요'); throw e; }
    await q('DELETE FROM user_tokens WHERE token_hash = $1 RETURNING 1', [sha(t)]);
    page(res, true, '이메일 인증이 끝났어요');
  }

  async function resetReq(b, addr, req, res) {
    if (!A.mailOn) return fail(res, 503, 'mail', '메일 서비스가 아직 준비되지 않아서 비밀번호 재설정을 쓸 수 없어요');
    const id = String(b.id == null ? '' : b.id).trim().toLowerCase().slice(0, 100);
    if (!id) return fail(res, 400, 'id', '아이디나 이메일을 입력해 주세요');
    if (!rate('rs:' + addr, 5, 3600 * 1000) || !rate('rt:' + id, 3, 3600 * 1000)) return fail(res, 429, 'rate', '너무 자주 요청했어요. 잠시 후 다시 해 주세요');
    const r = id.indexOf('@') >= 0
      ? await q('SELECT id, email FROM users WHERE email_key = $1 AND email_verified', [id])
      : await q('SELECT id, email FROM users WHERE username = $1 AND email_verified', [id]);
    const row = r.rows[0];
    if (row) {
      try {
        const raw = await makeToken(row.id, 'reset', null, 30);
        await sendMail(row.email, '[스핀 클래시] 비밀번호 재설정', '아래 링크에서 새 비밀번호를 정해요 (30분 안에).\n\n' + baseUrl(req) + '/?reset=' + raw + '\n\n본인이 요청하지 않았다면 이 메일을 무시해도 돼요. 비밀번호는 바뀌지 않아요.');
      } catch (e) { console.log('[accounts] 재설정 메일 실패:', e.message); }
    }
    send(res, 200, { ok: true, m: '인증된 이메일이 등록된 계정이면 재설정 메일을 보냈어요' });   // 있든 없든 같은 답
  }

  async function resetConfirm(b, addr, res) {
    if (!rate('rc:' + addr, 10, 3600 * 1000)) return fail(res, 429, 'rate', '너무 자주 시도했어요. 잠시 후 다시 해 주세요');
    const t = String(b.t == null ? '' : b.t); if (t.length < 20 || t.length > 80) return fail(res, 400, 'token', '링크가 올바르지 않아요');
    const r = await q("SELECT t.user_id, u.username FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.kind = 'reset' AND t.expires_at > now()", [sha(t)]);
    const row = r.rows[0]; if (!row) return fail(res, 400, 'token', '링크가 만료됐거나 이미 사용됐어요');
    const pw = vPw(b.p, row.username); if (pw.err) return fail(res, 400, 'pw', pw.err);
    const h = await limited(() => hashPw(pw.v));
    await q('UPDATE users SET pw_hash = $1 WHERE id = $2 RETURNING 1', [h, row.user_id]);
    await q('DELETE FROM sessions WHERE user_id = $1 RETURNING 1', [row.user_id]);
    await q("DELETE FROM user_tokens WHERE user_id = $1 AND kind = 'reset' RETURNING 1", [row.user_id]);
    send(res, 200, { ok: true });
  }

  async function delAccount(u, b, res) {
    if (!rate('del:' + u.id, 5, 3600 * 1000)) return fail(res, 429, 'rate', '너무 자주 시도했어요');
    if (!(await verifyOwnPw(u, b.p))) return fail(res, 401, 'pw', '비밀번호가 맞지 않아요');
    await q('DELETE FROM users WHERE id = $1 RETURNING 1', [u.id]);
    nickKeys.delete(normKey(u.nick));
    send(res, 200, { ok: true });
  }

  return A;
};
module.exports.helpers = { normKey, cleanNick, isGhost };
