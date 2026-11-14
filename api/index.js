"use strict";
/* API publik: katalog, status pengajuan, catat pengajuan. Setara api.php. */
const c = require("../lib/core");
const seed = require("../lib/seed.json");
const TIPE = ["layanan", "pinjam", "pesanan"];
const CODE = /^PE-\d{4}-[A-Z0-9]{4,6}(-\d)?$/;
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

function phone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1); else if (d.startsWith("8")) d = "62" + d;
  return d.startsWith("62") && d.length >= 10 && d.length <= 15 ? d : "";
}

module.exports = async (req, res) => {
  const q = req.query;
  if (req.method === "GET") {
    if (q.ping) return c.send(res, 200, { ok: true, ready: c.hasDb(), why: c.hasDb() ? "" : "no_db" });
    if (q.catalog) {
      let b = null, v = null;
      try { [b, v] = [parse(await c.redis("GET", "books")), parse(await c.redis("GET", "videos"))]; } catch {}
      b = (b || seed.books).filter(x => x.aktif !== false); v = (v || seed.videos).filter(x => x.aktif !== false);
      const book = x => ({ id: x.id, judul: x.judul, penulis: x.penulis, kat: x.kat, pinjam: !!x.pinjam, beli: !!x.beli, harga: x.harga ?? null, sp: x.sp ?? null, sb: x.sb ?? null });
      const vid = x => ({ id: x.id, judul: x.judul, kat: x.kat, youtube: x.youtube || "", mp4: x.mp4 || "", terkait: x.terkait || "", ai: x.ai && x.ai.jenis && x.ai.task ? x.ai : null });
      return c.send(res, 200, { ok: true, books: b.map(book), videos: v.map(vid) });
    }
    if (q.status) {
      if (!c.session(req)) return c.fail(res, 401, "Silakan masuk dulu.");
      const code = String(q.status);
      if (!CODE.test(code)) return c.fail(res, 400, "Kode pengajuan tidak sah.");
      if (!(await c.hit("st:" + c.ipId(req), 60, 3600))) return c.fail(res, 429, "Terlalu banyak pengecekan. Coba lagi nanti.");
      const r = c.hasDb() ? parse(await c.redis("GET", "sub:" + code)) : null;
      if (!r) return c.fail(res, 404, "Kode belum tercatat di server. Pengajuan yang dikirim lewat WhatsApp atau email tetap diproses pengelola.");
      return c.send(res, 200, { ok: true, status: r.status, diubah: r.diubah });
    }
    return c.fail(res, 400, "Permintaan tidak dikenal.");
  }
  if (req.method !== "POST") return c.fail(res, 405, "Metode tidak diizinkan.");
  if (!c.xhr(req)) return c.fail(res, 403, "Permintaan ditolak.");
  const user = c.session(req); if (!user) return c.fail(res, 401, "Silakan masuk dulu.");
  if (!c.hasDb()) return c.fail(res, 503, "Database belum siap.");
  const i = req.body || {};
  if (i.action !== "submit") return c.fail(res, 400, "Format permintaan tidak sah.");
  if (!TIPE.includes(i.tipe)) return c.fail(res, 400, "Jenis pengajuan tidak dikenal.");
  if (!CODE.test(String(i.kode))) return c.fail(res, 400, "Kode pengajuan tidak sah.");
  const t = c.txt, wa = phone(i.wa);
  const r = { tipe: i.tipe, waktu: Math.floor(Date.now() / 1000), nama: t(i.nama, 100), nim: t(i.nim, 20), prodi: t(i.prodi, 80), wa, email: t(i.email, 120),
    ringkas: t(i.ringkas, 300), jadwal: t(i.jadwal, 200), via: ["wa", "email", "copy"].includes(i.via) ? i.via : "copy", detail: t(i.detail, 4000, true),
    status: "baru", catatan: "", diubah: Math.floor(Date.now() / 1000), oleh: user.id };
  if (r.nama.length < 3) return c.fail(res, 400, "Nama belum lengkap.");
  if (!wa) return c.fail(res, 400, "Nomor WhatsApp tidak sah.");
  if (r.tipe !== "pesanan" && !/^[A-Za-z0-9.\-/]{5,20}$/.test(r.nim)) return c.fail(res, 400, "NIM tidak sah.");
  if (r.tipe !== "pesanan" && r.prodi.length < 2) return c.fail(res, 400, "Program studi belum diisi.");
  if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return c.fail(res, 400, "Format email tidak sah.");
  if (!r.detail) return c.fail(res, 400, "Isi pengajuan kosong.");
  const day = new Date().toISOString().slice(0, 10);
  if (!(await c.hit("sg:" + day, 2000, 86400))) return c.fail(res, 429, "Server sedang menerima terlalu banyak pengajuan hari ini. Kirim lewat WhatsApp saja.");
  if (!(await c.hit("sh:" + user.id, 20, 3600))) return c.fail(res, 429, "Terlalu banyak pengajuan dari akun ini. Coba lagi nanti.");
  for (let n = 0; n < 9; n++) {
    const kode = n === 0 ? i.kode : i.kode + "-" + (n + 1);
    if ((await c.redis("SET", "sub:" + kode, JSON.stringify({ kode, ...r }), "NX")) === "OK") {
      await c.redis("LPUSH", "subs", kode);
      return c.send(res, 200, { ok: true, kode });
    }
  }
  c.fail(res, 409, "Kode pengajuan bentrok. Coba kirim ulang.");
};
