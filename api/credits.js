"use strict";
/* Kredit, billing, dan afiliasi. Tidak ada payment gateway sungguhan di situs ini:
   pengguna mengajukan top-up atau klaim referral, admin mengonfirmasi lewat admin.html —
   pola yang sama persis dengan alur pemesanan buku yang sudah ada di situs ini. */
const crypto = require("crypto");
const c = require("../lib/core");
const num = (k, d) => +c.env[k] || d;
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const newId = () => crypto.randomBytes(6).toString("hex");
const AF_CODE_RE = /^[A-Z0-9]{6,12}$/;

const genAfCode = uid => "PE" + crypto.createHash("sha1").update(uid + ":" + (c.env.SESSION_SECRET || "x")).digest("hex").slice(0, 6).toUpperCase();
async function ensureAfCode(uid) {
  const have = await c.redis("GET", "af:code:" + uid);
  if (have) return have;
  const base = genAfCode(uid);
  for (let n = 0; n < 5; n++) {
    const tryCode = n === 0 ? base : base + n;
    const owner = await c.redis("GET", "af:owner:" + tryCode);
    if (!owner || owner === uid) {
      await c.redis("SET", "af:owner:" + tryCode, uid, "NX");
      await c.redis("SET", "af:code:" + uid, tryCode);
      return tryCode;
    }
  }
  const tryCode = base + Date.now().toString(36).slice(-3).toUpperCase();
  await c.redis("SET", "af:owner:" + tryCode, uid, "NX");
  await c.redis("SET", "af:code:" + uid, tryCode);
  return tryCode;
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    if (req.query.ping) return c.send(res, 200, { ok: true, ready: c.hasDb() });
    if (req.query.me) {
      const user = c.session(req); if (!user) return c.fail(res, 401, "Silakan masuk dulu.");
      if (!c.hasDb()) return c.send(res, 200, { ok: true, saldo: 0, riwayat: [], kodeAfiliasi: "", jumlahReferral: 0, sudahKlaimReferral: false });
      let bal = null, ids = [], code = "", afCount = null, afUsed = null;
      try { bal = await c.redis("GET", "cr:bal:" + user.id); } catch {}
      try { ids = (await c.redis("LRANGE", "cr:hist:" + user.id, 0, 29)) || []; } catch {}
      try { code = await ensureAfCode(user.id); } catch { code = ""; }
      try { afCount = await c.redis("GET", "af:count:" + user.id); } catch {}
      try { afUsed = await c.redis("GET", "af:used:" + user.id); } catch {}
      let riwayat = [];
      if (ids.length) {
        try { const out = await c.pipeline(ids.map(id => ["GET", "cr:tx:" + id])); riwayat = out.map(o => parse(o && o.result)).filter(Boolean); } catch {}
      }
      return c.send(res, 200, { ok: true, saldo: +bal || 0, riwayat, kodeAfiliasi: code, jumlahReferral: +afCount || 0, sudahKlaimReferral: !!afUsed });
    }
    return c.fail(res, 400, "Permintaan tidak dikenal.");
  }
  if (req.method !== "POST" || !c.xhr(req)) return c.fail(res, 403, "Permintaan ditolak.");
  const user = c.session(req); if (!user) return c.fail(res, 401, "Silakan masuk dulu.");
  if (!c.hasDb()) return c.fail(res, 503, "Database belum siap. Pengelola perlu memasang Upstash Redis dulu.");
  const i = req.body || {};

  if (i.action === "topup-request") {
    const jumlah = Math.floor(+i.jumlah), maxTopup = num("TOPUP_MAX", 1000);
    if (!Number.isFinite(jumlah) || jumlah < 1 || jumlah > maxTopup) return c.fail(res, 400, `Jumlah kredit tidak sah. Minimal 1, maksimal ${maxTopup} per pengajuan.`);
    const catatan = c.txt(i.catatan, 300, true);
    if (!(await c.hit("cr:rq:" + user.id, num("TOPUP_PER_USER_PER_DAY", 5), 86400))) return c.fail(res, 429, "Terlalu banyak pengajuan top-up hari ini. Coba lagi besok, atau hubungi admin lewat WhatsApp.");
    const id = newId();
    const tx = { id, uid: user.id, type: "topup", jumlah, status: "menunggu", catatan, waktu: Math.floor(Date.now() / 1000) };
    await c.redis("SET", "cr:tx:" + id, JSON.stringify(tx));
    await c.redis("LPUSH", "cr:hist:" + user.id, id); await c.redis("LTRIM", "cr:hist:" + user.id, 0, 199);
    await c.redis("LPUSH", "cr:pendinglist", id); await c.redis("LTRIM", "cr:pendinglist", 0, 499);
    return c.send(res, 200, { ok: true, id });
  }

  if (i.action === "referral-claim") {
    const kode = String(i.kode || "").trim().toUpperCase();
    if (!AF_CODE_RE.test(kode)) return c.fail(res, 400, "Format kode referral tidak sah.");
    let already = null; try { already = await c.redis("GET", "af:used:" + user.id); } catch {}
    if (already) return c.fail(res, 400, "Akun ini sudah pernah mengajukan klaim kode referral.");
    const ownerUid = await c.redis("GET", "af:owner:" + kode);
    if (!ownerUid) return c.fail(res, 404, "Kode referral tidak ditemukan. Periksa kembali penulisannya.");
    if (ownerUid === user.id) return c.fail(res, 400, "Tidak bisa memakai kode referral milik sendiri.");
    if (!(await c.hit("af:rq:" + user.id, 3, 86400))) return c.fail(res, 429, "Terlalu banyak percobaan. Coba lagi besok.");
    const id = newId();
    const claim = { id, uid: user.id, ownerUid, kode, status: "menunggu", waktu: Math.floor(Date.now() / 1000) };
    await c.redis("SET", "af:claim:" + id, JSON.stringify(claim));
    await c.redis("LPUSH", "af:pendinglist", id); await c.redis("LTRIM", "af:pendinglist", 0, 499);
    return c.send(res, 200, { ok: true, id });
  }

  return c.fail(res, 400, "Format permintaan tidak sah.");
};
