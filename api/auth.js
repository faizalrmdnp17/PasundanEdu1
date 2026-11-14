"use strict";
const c = require("../lib/core");
const pub = s => ({ id: s.id, nama: s.nama, peran: s.peran, nim: s.nim });

module.exports = async (req, res) => {
  const a = req.query.a;
  if (a === "me") { const s = c.session(req); return s ? c.send(res, 200, { ok: true, user: pub(s) }) : c.fail(res, 401, "Belum masuk."); }
  if (req.method !== "POST" || !c.xhr(req)) return c.fail(res, 403, "Permintaan ditolak.");
  if (a === "logout") return c.send(res, 200, { ok: true }, { "Set-Cookie": c.cookie("", 0) });
  if (a !== "login") return c.fail(res, 400, "Permintaan tidak dikenal.");

  let users = [];
  try { users = JSON.parse(c.env.LOGIN_USERS || "[]"); } catch {}
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 16 || !users.length) return c.fail(res, 503, "Login belum dikonfigurasi oleh pengelola (SESSION_SECRET dan LOGIN_USERS).");
  if (!(await c.hit("lg:" + c.ipId(req), 8, 900))) return c.fail(res, 429, "Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.");

  const id = c.txt((req.body || {}).id, 60).toLowerCase(), pw = String((req.body || {}).pw || "").slice(0, 200);
  const u = users.find(x => String(x.id).toLowerCase() === id);
  const want = u ? (u.sha256 ? Buffer.from(u.sha256, "hex") : c.sha(u.sandi)) : c.sha("x");
  const got = c.sha(pw);
  const ok = !!u && want.length === got.length && require("crypto").timingSafeEqual(want, got);
  if (!ok) return c.fail(res, 401, "NIM/username atau kata sandi salah.");

  const hours = Math.min(72, Math.max(1, +c.env.SESSION_HOURS || 12));
  const s = { id: u.id, nama: u.nama || u.id, peran: u.peran === "Admin" ? "Admin" : (u.peran || "Mahasiswa"), nim: u.nim || "-", exp: Date.now() + hours * 36e5 };
  c.send(res, 200, { ok: true, user: pub(s) }, { "Set-Cookie": c.cookie(c.sign(s), hours * 3600) });
};
