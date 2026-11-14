"use strict";
/* Cek Plagiasi: pemeriksa kemiripan teks, BUKAN pengganti Turnitin resmi kampus.
   Membandingkan teks terhadap dokumen lain yang pernah diperiksa lewat fitur ini di situs ini
   (basis data tertutup/terbatas milik situs, bukan basis data skripsi/jurnal nasional atau internet).
   Memakai teknik word-shingling: teks dipecah jadi potongan 7 kata berurutan, tiap potongan di-hash
   (teks aslinya TIDAK disimpan, hanya hash-nya) lalu dibandingkan dengan kemiripan Jaccard. */
const crypto = require("crypto");
const c = require("../lib/core");
const num = (k, d) => +c.env[k] || d;
const SHINGLE_N = 7;

function normWords(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
}
function shingleSet(text, n = SHINGLE_N) {
  const words = normWords(text), set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(" "));
  return set;
}
const hashShingle = s => crypto.createHash("sha1").update(s).digest("base64url").slice(0, 14);
function jaccard(hashArr, hashSet) {
  if (!hashArr.length || !hashSet.size) return 0;
  let inter = 0;
  for (const h of hashArr) if (hashSet.has(h)) inter++;
  const union = hashArr.length + hashSet.size - inter;
  return union ? inter / union : 0;
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    if (req.query.ping) return c.send(res, 200, { ok: true, ready: c.hasDb(), why: c.hasDb() ? "" : "no_db" });
    return c.fail(res, 400, "Permintaan tidak dikenal.");
  }
  if (req.method !== "POST" || !c.xhr(req)) return c.fail(res, 403, "Permintaan ditolak.");
  const user = c.session(req); if (!user) return c.fail(res, 401, "Silakan masuk dulu.");
  if (!c.hasDb()) return c.fail(res, 503, "Database belum siap. Pengelola perlu memasang Upstash Redis dulu.");

  const i = req.body || {};
  if (i.action !== "check") return c.fail(res, 400, "Format permintaan tidak sah.");
  const text = c.txt(i.text, 20000, true);
  const judul = c.txt(i.judul, 140) || "(tanpa judul)";
  if (text.length < 300) return c.fail(res, 400, "Teks terlalu pendek untuk diperiksa. Tempel minimal sekitar 300 karakter (beberapa paragraf).");

  const day = new Date().toISOString().slice(0, 10);
  if (!(await c.hit("sim:g:" + day, num("SIM_GLOBAL_PER_DAY", 300), 86400))) return c.fail(res, 429, "Pemeriksaan kemiripan hari ini sudah mencapai batas pemakaian situs. Coba lagi besok.");
  if (!(await c.hit("sim:d:" + user.id, num("SIM_PER_USER_PER_DAY", 15), 86400))) return c.fail(res, 429, "Batas pemeriksaan harian akun ini tercapai. Coba lagi besok.");

  const mySet = shingleSet(text);
  if (mySet.size < 5) return c.fail(res, 400, "Teks terlalu pendek atau kurang bervariasi untuk diperiksa (perlu sekitar 40 kata berbeda atau lebih).");
  const myHashes = [...mySet].map(hashShingle);

  let ids = [];
  try { ids = (await c.redis("LRANGE", "sim:index", 0, num("SIM_CORPUS_MAX", 400) - 1)) || []; } catch { ids = []; }
  ids = (ids || []).filter(Boolean);

  let matches = [];
  if (ids.length) {
    let sets = ids.map(() => new Set());
    try {
      const out = await c.pipeline(ids.map(id => ["SMEMBERS", "sim:doc:" + id]));
      sets = out.map(o => new Set((o && o.result) || []));
    } catch { /* indeks pembanding tidak bisa diambil, lanjut tanpa pembanding */ }
    const scored = ids.map((id, k) => ({ id, score: jaccard(myHashes, sets[k]) })).filter(m => m.score > 0.08);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 6);
    if (top.length) {
      let metaOut = [];
      try { metaOut = await c.pipeline(top.map(m => ["GET", "sim:meta:" + m.id])); } catch { metaOut = []; }
      matches = top.map((m, idx) => {
        let meta = null; try { meta = JSON.parse((metaOut[idx] && metaOut[idx].result) || "null"); } catch {}
        return {
          persen: Math.round(m.score * 1000) / 10,
          milikSendiri: !!(meta && meta.uid === user.id),
          judul: (meta && meta.judul) || "(tanpa judul)",
          waktu: meta ? meta.waktu : null
        };
      });
    }
  }

  const docId = crypto.randomBytes(8).toString("hex"), ttl = 60 * 60 * 24 * 365;
  try {
    await c.redis("SADD", "sim:doc:" + docId, ...myHashes);
    await c.redis("EXPIRE", "sim:doc:" + docId, ttl);
    await c.redis("SET", "sim:meta:" + docId, JSON.stringify({ uid: user.id, judul, waktu: Math.floor(Date.now() / 1000) }), "EX", ttl);
    await c.redis("LPUSH", "sim:index", docId);
    await c.redis("LTRIM", "sim:index", 0, num("SIM_CORPUS_MAX", 400) - 1);
  } catch { /* gagal menyimpan ke indeks pembanding; hasil pemeriksaan tetap dikembalikan */ }

  return c.send(res, 200, { ok: true, jumlahShingle: myHashes.length, dibandingkan: ids.length, matches });
};
