import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// id di skema ini SERIAL (int4). Di atas batas ini postgres balas 22003,
// bukan "tidak ditemukan" - dulu jadinya 500.
const MAX_INT4 = 2147483647;

// Teks yang aman dilempar ke postgres. NUL byte ditolak postgres, dan lone
// surrogate diam-diam jadi U+FFFD pas di-encode (data berubah tanpa kabar).
const isValidText = (s) => !s.includes('\u0000') && s.isWellFormed();

// Number() terlalu longgar: true -> 1, [1] -> 1, "1e0" -> 1, "0x10" -> 16.
// Kalau dibiarkan, input salah tipe bisa diam-diam nulis ke user lain.
const toId = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
  if (s === null || !/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
};

// Batas panjang dihitung per grapheme, bukan per code unit: satu emoji = 1
// karakter, sama kayak hitungan orang. Intl.Segmenter kalau ada, kalau nggak
// ya jatuh ke code point.
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('id', { granularity: 'grapheme' })
    : null;

const countChars = (s) => {
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n += 1;
  return n;
};

// code unit selalu >= grapheme, jadi kalau panjang code unit masih di bawah
// batas nggak usah dihitung yang mahal
const tooLong = (s, max) => s.length > max && countChars(s) > max;

// Trim, tapi jangan dipotong diam-diam: kelebihan panjang ditolak 400, bukan
// dipotong. Balikin { value } atau { error }.
const text = (v, max, label) => {
  if (v === undefined || v === null) return { value: '' };
  if (typeof v !== 'string') return { error: `${label} harus berupa teks` };
  const s = v.trim();
  if (!isValidText(s)) return { error: `${label} mengandung karakter tidak valid` };
  if (tooLong(s, max)) return { error: `${label} maksimal ${max} karakter` };
  return { value: s };
};

// req.body bisa undefined kalau client nggak kirim JSON. Lewat sini semua,
// biar balasannya 400, bukan 500.
const bodyOf = (req) =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailOf = (v) => {
  if (v === undefined || v === null) return { value: '' };
  if (typeof v !== 'string') return { error: 'email harus berupa teks' };
  const s = v.trim();
  if (!s || tooLong(s, 200) || !isValidText(s)) return { error: 'email tidak valid' };
  return EMAIL_RE.test(s) ? { value: s.toLowerCase() } : { error: 'email tidak valid' };
};

// field beneran dikirim client? (null dianggap nggak dikirim)
const has = (body, key) => body[key] !== undefined && body[key] !== null;

function handleError(res, err) {
  // Satu-satunya UNIQUE di skema ini users.email. Kalau nanti nambah constraint
  // UNIQUE lain, cek constraint-nya dulu jangan asal lempar 409 "email dipakai".
  if (err.code === '23505' && (err.constraint ?? '').includes('email')) {
    return res.status(409).json({ error: 'Email sudah dipakai' });
  }
  if (err.code === '23503') return res.status(400).json({ error: 'User tidak ditemukan' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

const MAX_LIMIT = 500;

// limit/offset opsional. Tanpa limit semua baris keluar (perilaku lama, klien
// lama aman); kalau dikirim, dibatasi biar satu request nggak narik satu tabel.
const optInt = (v, label, { min = 0, maks = MAX_LIMIT } = {}) => {
  if (v === undefined || v === null || v === '') return { value: null };
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v.trim())) {
    return { error: `${label} harus berupa angka bulat` };
  }
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n) || n < min || n > maks) {
    return { error: `${label} harus antara ${min} dan ${maks}` };
  }
  return { value: n };
};

/**
 * Bikin Express app di atas pool yang sudah jadi. Dipisah dari server.js
 * biar gampang dites tanpa harus dengerin port tetap.
 */
export function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json());

  // ---- users ----
  app.get('/api/users', async (req, res) => {
    const q = text(req.query.q, 100, 'q');
    const limit = optInt(req.query.limit, 'limit', { min: 1 });
    const offset = optInt(req.query.offset, 'offset');
    if (q.error || limit.error || offset.error) {
      return res.status(400).json({ error: q.error || limit.error || offset.error });
    }
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.created_at, u.updated_at,
                COUNT(n.id)::int AS note_count
           FROM users u
           LEFT JOIN notes n ON n.user_id = u.id
          WHERE ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2)
          GROUP BY u.id
          -- id jadi tie-breaker, biar nama kembar nggak bikin urutan
          -- (dan hasil pagination) goyang antar request
          ORDER BY u.name, u.id
          LIMIT $3 OFFSET $4`,
        [q.value, `%${escapeLike(q.value)}%`, limit.value, offset.value ?? 0]
      );
      res.json(rows);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/users/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });
      res.json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/users', async (req, res) => {
    const body = bodyOf(req);
    const name = text(body.name, 100, 'name');
    const email = emailOf(body.email);
    if (name.error || email.error) {
      return res.status(400).json({ error: name.error || email.error });
    }
    if (!name.value) return res.status(400).json({ error: 'name wajib diisi' });
    if (!email.value) return res.status(400).json({ error: 'email tidak valid' });
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
        [name.value, email.value]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.put('/api/users/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    const body = bodyOf(req);

    // update parsial: field yang nggak dikirim dibiarkan
    const patchName = has(body, 'name');
    const patchEmail = has(body, 'email');
    if (!patchName && !patchEmail) {
      return res.status(400).json({ error: 'tidak ada field yang diubah (name/email)' });
    }

    let name = null;
    let email = null;
    if (patchName) {
      const r = text(body.name, 100, 'name');
      if (r.error) return res.status(400).json({ error: r.error });
      if (!r.value) return res.status(400).json({ error: 'name wajib diisi' });
      name = r.value;
    }
    if (patchEmail) {
      const r = emailOf(body.email);
      if (r.error) return res.status(400).json({ error: r.error });
      email = r.value;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE users
            SET name       = COALESCE($1, name),
                email      = COALESCE($2, email),
                updated_at = now()
          WHERE id = $3 RETURNING *`,
        [name, email, id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User tidak ditemukan' });
      res.json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete('/api/users/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    try {
      // notes-nya ikut kehapus lewat ON DELETE CASCADE
      const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'User tidak ditemukan' });
      res.status(204).end();
    } catch (err) {
      handleError(res, err);
    }
  });

  // ---- notes ----
  // rute statis harus didaftarin sebelum '/api/notes/:id'
  app.get('/api/notes/categories', async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT DISTINCT category FROM notes ORDER BY category');
      res.json(rows.map((r) => r.category));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/notes', async (req, res) => {
    const q = text(req.query.q, 100, 'q');
    const category = text(req.query.category, 50, 'category');
    const limit = optInt(req.query.limit, 'limit', { min: 1 });
    const offset = optInt(req.query.offset, 'offset');
    if (q.error || category.error || limit.error || offset.error) {
      return res.status(400).json({ error: q.error || category.error || limit.error || offset.error });
    }
    // '' = nggak difilter (frontend selalu ngirim parameternya), tapi nilai
    // lain yang bukan angka tetap ditolak
    const rawUserId = req.query.user_id;
    const adaUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== '';
    const userId = adaUserId ? toId(rawUserId) : null;
    if (adaUserId && !userId) return res.status(400).json({ error: 'user_id tidak valid' });

    try {
      const { rows } = await pool.query(
        `SELECT n.*, u.name AS user_name, u.email AS user_email
           FROM notes n
           JOIN users u ON u.id = n.user_id
          WHERE ($1 = '' OR n.title ILIKE $2 OR n.content ILIKE $2)
            AND ($3 = '' OR n.category = $3)
            AND ($4::int IS NULL OR n.user_id = $4)
          -- tie-breaker id, soalnya updated_at bisa kembar pas di-paginate
          ORDER BY n.updated_at DESC, n.id DESC
          LIMIT $5 OFFSET $6`,
        [q.value, `%${escapeLike(q.value)}%`, category.value, userId, limit.value, offset.value ?? 0]
      );
      res.json(rows);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/api/notes/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    try {
      const { rows } = await pool.query(
        `SELECT n.*, u.name AS user_name, u.email AS user_email
           FROM notes n JOIN users u ON u.id = n.user_id
          WHERE n.id = $1`,
        [id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Note tidak ditemukan' });
      res.json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/api/notes', async (req, res) => {
    const body = bodyOf(req);
    const userId = toId(body.user_id);
    const title = text(body.title, 200, 'title');
    const content = text(body.content, 10000, 'content');
    const category = text(body.category, 50, 'category');
    if (!userId) return res.status(400).json({ error: 'user_id dan title wajib diisi' });
    if (title.error || content.error || category.error) {
      return res.status(400).json({ error: title.error || content.error || category.error });
    }
    if (!title.value) return res.status(400).json({ error: 'user_id dan title wajib diisi' });
    try {
      // bentuk respons disamain sama GET /api/notes/:id (bawa user_name /
      // user_email), jadi frontend nggak perlu request ulang abis nyimpen
      const { rows } = await pool.query(
        `WITH ins AS (
           INSERT INTO notes (user_id, title, content, category)
           VALUES ($1, $2, $3, $4) RETURNING *
         )
         SELECT ins.*, u.name AS user_name, u.email AS user_email
           FROM ins JOIN users u ON u.id = ins.user_id`,
        [userId, title.value, content.value, category.value || 'umum']
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.put('/api/notes/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    const body = bodyOf(req);
    const title = text(body.title, 200, 'title');
    const content = text(body.content, 10000, 'content');
    const category = text(body.category, 50, 'category');
    const userId = toId(body.user_id);
    if (title.error || content.error || category.error) {
      return res.status(400).json({ error: title.error || content.error || category.error });
    }
    if (!title.value) return res.status(400).json({ error: 'title wajib diisi' });
    if (!userId) return res.status(400).json({ error: 'user_id wajib diisi' });
    try {
      const { rows } = await pool.query(
        `WITH upd AS (
           UPDATE notes
              SET title      = $1,
                  content    = $2,
                  category   = $3,
                  user_id    = $4,
                  updated_at = now()
            WHERE id = $5 RETURNING *
         )
         SELECT upd.*, u.name AS user_name, u.email AS user_email
           FROM upd JOIN users u ON u.id = upd.user_id`,
        [title.value, content.value, category.value || 'umum', userId, id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Note tidak ditemukan' });
      res.json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete('/api/notes/:id', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid' });
    try {
      const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Note tidak ditemukan' });
      res.status(204).end();
    } catch (err) {
      handleError(res, err);
    }
  });

  // endpoint /api/* yang nggak dikenal: tetap JSON, jangan halaman HTML Express
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan' });
  });

  // Error handler terakhir. Balikin JSON terus, tanpa stack trace / path file.
  // Error dari body-parser juga nyasar ke sini (JSON rusak -> 400, kebesaran -> 413).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
      return res.status(400).json({ error: 'Body JSON tidak valid' });
    }
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'Body terlalu besar' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
