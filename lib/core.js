"use strict";
/* Bantuan bersama untuk fungsi server Vercel: database (Upstash Redis lewat REST), sesi bertanda tangan, batas pemakaian. */
const crypto = require("crypto");
const env = process.env;
const URL_ = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
const hasDb = () => !!(URL_ && TOKEN);

async function redis(...cmd) {
  if (!hasDb()) throw new Error("no_db");
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
/* true bila masih di bawah batas. Bila database belum ada, batas dilewati. */
async function hit(key, limit, ttl) {
  try { const n = await redis("INCR", key); if (n === 1) await redis("EXPIRE", key, ttl); return n <= limit; }
  catch { return true; }
}
/* beberapa perintah Redis sekaligus lewat satu permintaan HTTP (endpoint /pipeline Upstash).
   Mengembalikan array hasil mentah ({result} atau {error}) sepanjang cmds, tanpa melempar per-perintah,
   supaya pemanggil bisa menoleransi satu-dua perintah yang gagal tanpa menggagalkan semuanya. */
async function pipeline(cmds) {
  if (!hasDb()) throw new Error("no_db");
  if (!Array.isArray(cmds) || !cmds.length) return [];
  const r = await fetch(URL_ + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error((j && j.error) || "pipeline_error");
  return j;
}

const secret = () => env.SESSION_SECRET || "";
const mac = body => crypto.createHmac("sha256", secret()).update(body).digest("base64url");
function sign(p) { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + mac(b); }
function verify(tok) {
  if (!tok || !secret()) return null;
  const [b, s] = tok.split("."); if (!b || !s) return null;
  const x = Buffer.from(s), y = Buffer.from(mac(b));
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const session = req => { const m = /(?:^|;\s*)pe_sess=([^;]+)/.exec(req.headers.cookie || ""); return verify(m && m[1]); };
const cookie = (tok, maxAge) => `pe_sess=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function send(res, code, obj, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const k in headers) res.setHeader(k, headers[k]);
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => send(res, code, { ok: false, error: msg });
/* permintaan tulis harus dari situs sendiri */
function xhr(req) {
  if (String(req.headers["x-requested-with"] || "").toLowerCase() !== "pasundanedu") return false;
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
const ipId = req => crypto.createHmac("sha256", secret() || "x").update(String((req.headers["x-forwarded-for"] || "0").split(",")[0].trim())).digest("hex").slice(0, 20);
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const txt = (s, n, multi) => {
  if (s == null) return "";
  s = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!multi) s = s.replace(/[\r\n]+/g, " ");
  return s.trim().slice(0, n);
};
const int = v => (v === "" || v == null || !Number.isFinite(+v) || +v < 0 ? null : Math.floor(+v));
module.exports = { redis, pipeline, hit, hasDb, sign, session, cookie, send, fail, xhr, ipId, sha, txt, int, env };
