"use strict";
/* API admin (khusus akun berperan Admin). Menggantikan admin.php; antarmukanya ada di /admin. */
const c = require("../lib/core");
const seed = require("../lib/seed.json");
const STATUS = ["baru", "diproses", "siap", "selesai", "batal"];
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const slug = (s, d) => (/^[a-z0-9_-]{1,30}$/i.test(String(s || "")) ? String(s).toLowerCase() : d);
const ytId = s => { s = String(s || "").trim(); const m = /(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(s); return m ? m[1] : /^[\w-]{11}$/.test(s) ? s : ""; };
const num = (k, d) => +c.env[k] || d;
function userName(uid) {
  try { const users = JSON.parse(c.env.LOGIN_USERS || "[]"); const u = users.find(x => String(x.id).toLowerCase() === String(uid || "").toLowerCase()); return u ? (u.nama || u.id) : (uid || "-"); }
  catch { return uid || "-"; }
}
async function creditTx(uid, type, jumlah, catatan) {
  const crypto = require("crypto"), id = crypto.randomBytes(6).toString("hex");
  const tx = { id, uid, type, jumlah, status: "disetujui", catatan: catatan || "", waktu: Math.floor(Date.now() / 1000) };
  await c.redis("SET", "cr:tx:" + id, JSON.stringify(tx));
  await c.redis("LPUSH", "cr:hist:" + uid, id); await c.redis("LTRIM", "cr:hist:" + uid, 0, 199);
  await c.redis("INCRBY", "cr:bal:" + uid, jumlah);
  return tx;
}

function cleanBooks(rows) {
  return rows.slice(0, 500).map((x, n) => ({ id: c.txt(x.id, 20) || "b" + String(n + 1).padStart(2, "0"), judul: c.txt(x.judul, 200), penulis: c.txt(x.penulis, 150), kat: slug(x.kat, "umum"),
    pinjam: !!x.pinjam, beli: !!x.beli, harga: c.int(x.harga), sp: c.int(x.sp), sb: c.int(x.sb), aktif: x.aktif !== false })).filter(x => x.judul);
}
function cleanVideos(rows) {
  return rows.slice(0, 500).map((x, n) => ({ id: c.txt(x.id, 20) || "v" + String(n + 1).padStart(2, "0"), judul: c.txt(x.judul, 200), kat: slug(x.kat, "skripsi"), youtube: ytId(x.youtube),
    mp4: /^[\w./-]{1,200}$/.test(String(x.mp4 || "")) ? String(x.mp4) : "", terkait: c.txt(x.terkait, 150),
    ai: x.ai && slug(x.ai.jenis, "") && slug(x.ai.task, "") ? { jenis: slug(x.ai.jenis), task: slug(x.ai.task) } : null, aktif: x.aktif !== false })).filter(x => x.judul && (x.youtube || x.mp4));
}

module.exports = async (req, res) => {
  const u = c.session(req);
  if (!u) return c.fail(res, 401, "Belum masuk.");
  if (u.peran !== "Admin") return c.fail(res, 403, "Khusus admin.");
  if (!c.hasDb()) return c.fail(res, 503, "Database belum tersambung (lihat PANDUAN-PASANG.md).");
  try {
    if (req.method === "GET") {
      const w = req.query.what;
      if (w === "submissions") {
        const codes = (await c.redis("LRANGE", "subs", 0, 499)) || [];
        const rows = codes.length ? (await c.redis("MGET", ...codes.map(k => "sub:" + k))).map(parse).filter(Boolean) : [];
        return c.send(res, 200, { ok: true, rows });
      }
      if (w === "books" || w === "videos") { const r = parse(await c.redis("GET", w)); return c.send(res, 200, { ok: true, rows: r || seed[w], seed: !r }); }
      if (w === "topups") {
        const ids = ((await c.redis("LRANGE", "cr:pendinglist", 0, 199)) || []).filter(Boolean);
        let rows = [];
        if (ids.length) {
          const out = await c.pipeline(ids.map(id => ["GET", "cr:tx:" + id]));
          rows = out.map(o => parse(o && o.result)).filter(Boolean).map(t => ({ ...t, nama: userName(t.uid) }));
        }
        return c.send(res, 200, { ok: true, rows });
      }
      if (w === "affiliate") {
        const ids = ((await c.redis("LRANGE", "af:pendinglist", 0, 199)) || []).filter(Boolean);
        let rows = [];
        if (ids.length) {
          const out = await c.pipeline(ids.map(id => ["GET", "af:claim:" + id]));
          rows = out.map(o => parse(o && o.result)).filter(Boolean).map(x => ({ ...x, nama: userName(x.uid), namaPemilikKode: userName(x.ownerUid) }));
        }
        return c.send(res, 200, { ok: true, rows });
      }
      return c.fail(res, 400, "Permintaan tidak dikenal.");
    }
    if (req.method !== "POST" || !c.xhr(req)) return c.fail(res, 403, "Permintaan ditolak.");
    const b = req.body || {};
    if (b.action === "status") {
      const k = "sub:" + String(b.kode), r = parse(await c.redis("GET", k));
      if (!r) return c.fail(res, 404, "Pengajuan tidak ditemukan.");
      if (!STATUS.includes(b.status)) return c.fail(res, 400, "Status tidak sah.");
      r.status = b.status; r.catatan = c.txt(b.catatan, 500, true); r.diubah = Math.floor(Date.now() / 1000);
      await c.redis("SET", k, JSON.stringify(r));
      return c.send(res, 200, { ok: true });
    }
    if (b.action === "delete") { await c.redis("DEL", "sub:" + String(b.kode)); await c.redis("LREM", "subs", 0, String(b.kode)); return c.send(res, 200, { ok: true }); }
    if (b.action === "save" && (b.what === "books" || b.what === "videos") && Array.isArray(b.rows)) {
      const rows = (b.what === "books" ? cleanBooks : cleanVideos)(b.rows);
      await c.redis("SET", b.what, JSON.stringify(rows));
      return c.send(res, 200, { ok: true, count: rows.length, rows });
    }
    if (b.action === "topup-approve" || b.action === "topup-reject") {
      const id = c.txt(b.id, 20), tx = parse(await c.redis("GET", "cr:tx:" + id));
      if (!tx || tx.type !== "topup") return c.fail(res, 404, "Pengajuan top-up tidak ditemukan.");
      if (tx.status !== "menunggu") return c.fail(res, 409, "Pengajuan ini sudah diproses sebelumnya (status: " + tx.status + ").");
      if (b.action === "topup-approve") { tx.status = "disetujui"; await c.redis("INCRBY", "cr:bal:" + tx.uid, tx.jumlah); }
      else { tx.status = "ditolak"; tx.catatan = c.txt(b.catatan, 300, true) || tx.catatan; }
      tx.diubah = Math.floor(Date.now() / 1000);
      await c.redis("SET", "cr:tx:" + id, JSON.stringify(tx));
      await c.redis("LREM", "cr:pendinglist", 0, id);
      return c.send(res, 200, { ok: true });
    }
    if (b.action === "affiliate-approve" || b.action === "affiliate-reject") {
      const id = c.txt(b.id, 20), claim = parse(await c.redis("GET", "af:claim:" + id));
      if (!claim) return c.fail(res, 404, "Klaim referral tidak ditemukan.");
      if (claim.status !== "menunggu") return c.fail(res, 409, "Klaim ini sudah diproses sebelumnya (status: " + claim.status + ").");
      if (b.action === "affiliate-approve") {
        claim.status = "disetujui";
        await c.redis("SET", "af:used:" + claim.uid, claim.kode);
        await c.redis("INCR", "af:count:" + claim.ownerUid);
        await creditTx(claim.ownerUid, "referral_bonus", num("AFFILIATE_BONUS_REFERRER", 20), "Referral " + userName(claim.uid));
        await creditTx(claim.uid, "referral_referee_bonus", num("AFFILIATE_BONUS_REFEREE", 10), "Memakai kode referral " + claim.kode);
      } else { claim.status = "ditolak"; claim.catatan = c.txt(b.catatan, 300, true) || ""; }
      claim.diubah = Math.floor(Date.now() / 1000);
      await c.redis("SET", "af:claim:" + id, JSON.stringify(claim));
      await c.redis("LREM", "af:pendinglist", 0, id);
      return c.send(res, 200, { ok: true });
    }
    if (b.action === "credit-adjust") {
      const uid = c.txt(b.uid, 60), jumlah = Math.floor(+b.jumlah);
      if (!uid) return c.fail(res, 400, "ID akun kosong.");
      if (!Number.isFinite(jumlah) || jumlah === 0) return c.fail(res, 400, "Jumlah penyesuaian tidak sah.");
      await creditTx(uid, "admin_adjust", jumlah, c.txt(b.catatan, 300, true) || "Penyesuaian manual oleh admin");
      return c.send(res, 200, { ok: true });
    }
    c.fail(res, 400, "Format permintaan tidak sah.");
  } catch (e) { console.error("[admin]", e.message); c.fail(res, 500, "Terjadi galat di server."); }
};
