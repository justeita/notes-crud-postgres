import { test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startDatabase } from '../db.js';
import { createApp } from '../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;
let server;
let base;

// port dicari runtime, bukan hardcode 5434: biar nggak bentrok sama server dev
// (5433) atau sisa proses test yang belum mati
async function portBebas() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

beforeAll(async () => {
  // cluster terpisah, biar data dev nggak kena
  db = await startDatabase({
    databaseDir: path.join(__dirname, '..', 'data', 'test-db'),
    port: await portBebas(),
    database: 'app_test',
    verbose: false,
  });
  await db.pool.query('TRUNCATE users RESTART IDENTITY CASCADE');

  const app = createApp(db.pool);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await db?.stop();
});

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
};

// tiap test bikin datanya sendiri (nggak ada state global kayak `budi`/`siti`),
// jadi urutan test nggak ngaruh. email & kategori dikasih token unik biar nggak
// tabrakan sama data test lain di database yang sama
let seq = 0;
const emailUnik = (prefix = 'user') => `${prefix}${++seq}-${process.pid}@example.com`;
const tokenUnik = () => `tk${++seq}x${Math.random().toString(36).slice(2, 7)}`;

const buatUser = async (nama = 'User Uji', email = emailUnik()) =>
  (await api('POST', '/api/users', { name: nama, email })).data;

const buatNote = async (userId, isi = {}) =>
  (await api('POST', '/api/notes', { user_id: userId, title: 'note uji', ...isi })).data;

test('bikin user baru', async () => {
  const { status, data } = await api('POST', '/api/users', {
    name: 'Budi',
    email: 'Budi@Example.com',
  });
  expect(status).toBe(201);
  expect(data.name).toBe('Budi');
  expect(data.email).toBe('budi@example.com'); // dinormalisasi lowercase
});

test('email duplikat ditolak 409', async () => {
  const email = emailUnik('duplikat');
  expect((await api('POST', '/api/users', { name: 'Satu', email })).status).toBe(201);
  expect((await api('POST', '/api/users', { name: 'Dua', email })).status).toBe(409);
});

test('validasi input wajib', async () => {
  const u = await buatUser();
  expect((await api('POST', '/api/users', { name: '', email: emailUnik() })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: '' })).status).toBe(400);
});

test('relasi one-to-many: note milik user + note_count', async () => {
  const u = await buatUser('Punya Note');

  const awal = (await api('GET', '/api/users')).data.find((x) => x.id === u.id);
  expect(awal.note_count).toBe(0);

  const note = await api('POST', '/api/notes', {
    user_id: u.id,
    title: 'Rapat kerja',
    content: 'agenda Senin',
    category: 'kerja',
  });
  expect(note.status).toBe(201);
  expect(note.data.user_id).toBe(u.id);

  const list = (await api('GET', '/api/users')).data;
  expect(list.find((x) => x.id === u.id).note_count).toBe(1);
});

test('note dengan user_id tidak ada ditolak 400', async () => {
  const { status } = await api('POST', '/api/notes', { user_id: 99999, title: 'yatim' });
  expect(status).toBe(400);
});

test('cari di judul dan isi, wildcard di-escape', async () => {
  const u = await buatUser('Pencari');
  const token = tokenUnik();

  await buatNote(u.id, { title: `Belanja 100% fix_it ${token}`, content: 'agenda rapat' });
  await buatNote(u.id, { title: `lain ${token}`, content: 'isi biasa' });

  // cari di title dan di content, dibatasi user_id supaya tidak kena test lain
  expect((await api('GET', `/api/notes?user_id=${u.id}&q=${token}`)).data.length).toBe(2);
  expect((await api('GET', `/api/notes?user_id=${u.id}&q=agenda`)).data.length).toBe(1);

  // '%' harus dicari sebagai karakter literal, bukan wildcard semua baris
  const persen = await api('GET', `/api/notes?user_id=${u.id}&q=%25`);
  expect(persen.data.length).toBe(1);
  expect(persen.data[0].title).toContain('100%');

  // '_' juga literal: 'a_b' tidak boleh ikut match 'axb'
  const token2 = tokenUnik();
  await buatNote(u.id, { title: `a_b ${token2}` });
  await buatNote(u.id, { title: `axb ${token2}` });
  const garisBawah = await api('GET', `/api/notes?user_id=${u.id}&q=${encodeURIComponent('a_b')}`);
  expect(garisBawah.data.length).toBe(1);
  expect(garisBawah.data[0].title).toContain('a_b');
});

test('filter kategori dan user', async () => {
  const u = await buatUser('Filter');
  const kat = `kat-${tokenUnik()}`;
  await buatNote(u.id, { title: 'satu', category: kat });
  await buatNote(u.id, { title: 'dua', category: 'lain' });

  expect((await api('GET', `/api/notes?category=${kat}`)).data.length).toBe(1);
  expect((await api('GET', `/api/notes?user_id=${u.id}`)).data.length).toBe(2);
  expect((await api('GET', '/api/notes?user_id=abc')).status).toBe(400);
  // user_id dikirim dua kali -> array, bukan angka -> 400
  expect((await api('GET', `/api/notes?user_id=${u.id}&user_id=1`)).status).toBe(400);
});

test('daftar kategori unik dan terurut', async () => {
  const u = await buatUser('Kategori');
  const kat = `kat-${tokenUnik()}`;
  await buatNote(u.id, { title: 'a', category: kat });
  await buatNote(u.id, { title: 'b', category: kat });

  const { status, data } = await api('GET', '/api/notes/categories');
  expect(status).toBe(200);
  expect(data).toContain(kat);
  expect(data.filter((c) => c === kat).length).toBe(1); // DISTINCT
  expect([...data].sort()).toEqual(data); // ORDER BY
});

// pagination: limit/offset, urutan stabil, validasi
test('limit/offset memotong daftar dan urutan tetap stabil', async () => {
  const users = [
    await buatUser('Paging A', emailUnik('paginga')),
    await buatUser('Paging B', emailUnik('pagingb')),
    await buatUser('Paging C', emailUnik('pagingc')),
  ];
  const kat = `page-${tokenUnik()}`;
  for (const [i, u] of users.entries()) await buatNote(u.id, { title: `p${i}`, category: kat });

  // tanpa limit: perilaku lama, semua baris
  const semua = (await api('GET', `/api/notes?category=${kat}`)).data;
  expect(semua.length).toBe(3);
  expect((await api('GET', `/api/notes?category=${kat}&limit=`)).data.length).toBe(3); // '' = tanpa limit

  // dua halaman kalau digabung = semua baris, tanpa duplikat
  const hal1 = (await api('GET', `/api/notes?category=${kat}&limit=2`)).data;
  const hal2 = (await api('GET', `/api/notes?category=${kat}&limit=2&offset=2`)).data;
  expect(hal1.length).toBe(2);
  expect(hal2.length).toBe(1);
  const ids = (rows) => rows.map((n) => n.id).sort((a, b) => a - b);
  expect(ids([...hal1, ...hal2])).toEqual(ids(semua));

  // urutan sama antar request (tie-breaker id, bukan urutan acak)
  expect((await api('GET', `/api/notes?category=${kat}`)).data.map((n) => n.id)).toEqual(
    semua.map((n) => n.id)
  );

  // users juga mendukung limit/offset
  expect((await api('GET', '/api/users?limit=1')).data.length).toBe(1);

  // nilai aneh ditolak 400, bukan diabaikan diam-diam
  for (const qs of ['limit=0', 'limit=abc', 'limit=-1', 'limit=501', 'limit=1.5', 'offset=-1', 'offset=abc']) {
    expect((await api('GET', `/api/notes?${qs}`)).status).toBe(400);
    expect((await api('GET', `/api/users?${qs}`)).status).toBe(400);
  }
});

test('edit user dan note', async () => {
  const u = await buatUser('Budi');
  const n = await buatNote(u.id, { title: 'Belanja', content: 'lama', category: 'pribadi' });

  const upd = await api('PUT', `/api/users/${u.id}`, { name: 'Budi Santoso', email: u.email });
  expect(upd.status).toBe(200);
  expect(upd.data.name).toBe('Budi Santoso');

  const note = await api('PUT', `/api/notes/${n.id}`, {
    title: 'Belanja (edit)',
    content: 'roti',
    category: 'pribadi',
  });
  expect(note.status).toBe(200);
  expect(note.data.title).toBe('Belanja (edit)');
  expect(note.data.content).toBe('roti');
});

test('404 untuk id yang tidak ada', async () => {
  expect((await api('GET', '/api/notes/999999')).status).toBe(404);
  expect((await api('GET', '/api/users/999999')).status).toBe(404);
  expect((await api('PUT', '/api/users/999999', { name: 'a' })).status).toBe(404);
  expect((await api('PUT', '/api/notes/999999', { title: 'a' })).status).toBe(404);
  expect((await api('DELETE', '/api/notes/999999')).status).toBe(404);
  expect((await api('DELETE', '/api/users/999999')).status).toBe(404);
});

test('hapus user, note-nya ikut kehapus', async () => {
  const u = await buatUser('Hapus Saya');
  await buatNote(u.id, { title: 'ikut hilang 1' });
  await buatNote(u.id, { title: 'ikut hilang 2' });
  expect((await api('GET', `/api/notes?user_id=${u.id}`)).data.length).toBe(2);

  expect((await api('DELETE', `/api/users/${u.id}`)).status).toBe(204);

  expect((await api('GET', `/api/notes?user_id=${u.id}`)).data.length).toBe(0);
  expect((await api('GET', `/api/users/${u.id}`)).status).toBe(404);
});

test('hapus note', async () => {
  const u = await buatUser('Hapus Note');
  const created = await buatNote(u.id, { title: 'sementara' });

  expect((await api('DELETE', `/api/notes/${created.id}`)).status).toBe(204);
  expect((await api('GET', `/api/notes/${created.id}`)).status).toBe(404);
});

// dulu request tanpa body JSON jatuh ke 500. sekarang 400.
test('body kosong / bukan JSON ditolak 400 dengan pesan JSON', async () => {
  for (const [method, url] of [
    ['POST', '/api/users'],
    ['PUT', '/api/users/1'],
    ['POST', '/api/notes'],
    ['PUT', '/api/notes/1'],
  ]) {
    const res = await fetch(base + url, { method });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBeTruthy();
  }
});

test('JSON rusak ditolak 400 JSON (bukan halaman error HTML)', async () => {
  const res = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":',
  });
  expect(res.status).toBe(400);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = await res.text();
  expect(body).not.toContain('at <anonymous>'); // tidak ada stack trace
});

test('endpoint API tidak dikenal dibalas 404 JSON', async () => {
  const res = await fetch(base + '/api/tidakada');
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
});

test('format email divalidasi di server', async () => {
  const u = await buatUser();
  expect((await api('POST', '/api/users', { name: 'X', email: 'bukan-email' })).status).toBe(400);
  expect((await api('POST', '/api/users', { name: 'X', email: 'a@b' })).status).toBe(400);
  expect((await api('PUT', `/api/users/${u.id}`, { email: 'siti-at-example' })).status).toBe(400);
});

// PUT note harus bisa mindahin pemilik
test('PUT note bisa ganti pemilik, dan tanpa user_id pemilik tetap', async () => {
  const lama = await buatUser('Pemilik Lama');
  const baru = await buatUser('Pemilik Baru');
  const note = await buatNote(lama.id, { title: 'pindah pemilik' });

  const pindah = await api('PUT', `/api/notes/${note.id}`, {
    title: 'pindah pemilik',
    user_id: baru.id,
  });
  expect(pindah.status).toBe(200);
  expect(pindah.data.user_id).toBe(baru.id);

  const tetap = await api('PUT', `/api/notes/${note.id}`, { title: 'tetap di sini' });
  expect(tetap.status).toBe(200);
  expect(tetap.data.user_id).toBe(baru.id);

  // user_id tidak valid / tidak ada → 400
  expect((await api('PUT', `/api/notes/${note.id}`, { title: 'x', user_id: 'abc' })).status).toBe(400);
  expect((await api('PUT', `/api/notes/${note.id}`, { title: 'x', user_id: 99999 })).status).toBe(400);
});

// PUT parsial: field yang nggak dikirim jangan ikut kehapus
test('PUT note parsial mempertahankan content dan category', async () => {
  const u = await buatUser('Parsial');
  const note = await buatNote(u.id, {
    title: 'judul asli',
    content: 'isi penting',
    category: 'kerja',
  });

  const hanyaJudul = await api('PUT', `/api/notes/${note.id}`, { title: 'judul baru' });
  expect(hanyaJudul.status).toBe(200);
  expect(hanyaJudul.data.title).toBe('judul baru');
  expect(hanyaJudul.data.content).toBe('isi penting'); // dulu ikut jadi ''
  expect(hanyaJudul.data.category).toBe('kerja'); // dulu ikut jadi 'umum'

  // content '' tetap sah: artinya isi note dikosongkan
  const kosongkan = await api('PUT', `/api/notes/${note.id}`, { content: '' });
  expect(kosongkan.status).toBe(200);
  expect(kosongkan.data.content).toBe('');
  expect(kosongkan.data.title).toBe('judul baru');

  // body tanpa field apa pun ditolak, bukan no-op diam-diam
  expect((await api('PUT', `/api/notes/${note.id}`, {})).status).toBe(400);
});

test('PUT user parsial: cukup name saja atau email saja', async () => {
  const u = await buatUser('Awal', emailUnik('partial'));

  const nama = await api('PUT', `/api/users/${u.id}`, { name: 'Nama Baru' });
  expect(nama.status).toBe(200);
  expect(nama.data.name).toBe('Nama Baru');
  expect(nama.data.email).toBe(u.email);

  const email = await api('PUT', `/api/users/${u.id}`, { email: 'Baru@Example.com' });
  expect(email.status).toBe(200);
  expect(email.data.name).toBe('Nama Baru');
  expect(email.data.email).toBe('baru@example.com');

  expect((await api('PUT', `/api/users/${u.id}`, {})).status).toBe(400);
});

// handleError cuma map 23505 ke 409 kalau nama constraint-nya nyebut "email".
// test ini yang pertama merah kalau nama constraint-nya berubah (dulu jadi 500).
test('PUT user dengan email milik user lain ditolak 409', async () => {
  const a = await buatUser('Email A', emailUnik('emaila'));
  const b = await buatUser('Email B', emailUnik('emailb'));

  const bentrok = await api('PUT', `/api/users/${b.id}`, { email: a.email });
  expect(bentrok.status).toBe(409);
  expect(bentrok.data.error).toContain('Email');

  // email sendiri (walau beda kapitalisasi) tetap sah
  const sendiri = await api('PUT', `/api/users/${b.id}`, { email: b.email.toUpperCase() });
  expect(sendiri.status).toBe(200);
  expect(sendiri.data.email).toBe(b.email);
});

// user_id salah tipe jangan dikoersi jadi angka
test('user_id salah tipe ditolak 400, bukan dikoersi', async () => {
  const u = await buatUser('Tipe');

  // Number() lama menerima true -> 1, [id] -> id, "1e0" -> 1, "0x10" -> 16
  for (const v of [true, [u.id], '1e0', '0x10', 1.5, -1, '', {}]) {
    const r = await api('POST', '/api/notes', { user_id: v, title: 'x' });
    expect(r.status).toBe(400);
  }

  // string angka polos tetap diterima
  const ok = await api('POST', '/api/notes', { user_id: String(u.id), title: 'ok' });
  expect(ok.status).toBe(201);
  expect(ok.data.user_id).toBe(u.id);
});

// kepanjangan ditolak, bukan dipotong
test('input kepanjangan ditolak 400, bukan dipotong', async () => {
  const u = await buatUser('Panjang');

  expect((await api('POST', '/api/users', { name: 'A'.repeat(101), email: emailUnik() })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: 'T'.repeat(201) })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: 'ok', content: 'c'.repeat(10001) })).status).toBe(400);

  // tepat di batas masih diterima dan tersimpan utuh
  const pas = await api('POST', '/api/notes', {
    user_id: u.id,
    title: 'T'.repeat(200),
    content: 'c'.repeat(10000),
  });
  expect(pas.status).toBe(201);
  expect(pas.data.title.length).toBe(200);
  expect(pas.data.content.length).toBe(10000);
});

test('body terlalu besar dibalas 413 JSON', async () => {
  const u = await buatUser('Besar');
  const res = await fetch(base + '/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: u.id, title: 'big', content: 'y'.repeat(200_000) }),
  });
  expect(res.status).toBe(413);
  expect(res.headers.get('content-type')).toContain('application/json');
});

// di atas int4 postgres balas 22003, dulu jadi 500
test('id di luar jangkauan int4 ditolak, bukan 500', async () => {
  for (const id of ['2147483648', '9007199254740991']) {
    expect((await api('GET', `/api/users/${id}`)).status).toBe(400);
    expect((await api('GET', `/api/notes/${id}`)).status).toBe(400);
    expect((await api('DELETE', `/api/notes/${id}`)).status).toBe(400);
    expect((await api('PUT', `/api/users/${id}`, { name: 'x' })).status).toBe(400);
  }
  // batas atas yang masih sah tetap 404, bukan 400
  expect((await api('GET', '/api/users/2147483647')).status).toBe(404);

  expect((await api('POST', '/api/notes', { user_id: 2147483648, title: 'x' })).status).toBe(400);
  expect((await api('GET', '/api/notes?user_id=2147483648')).status).toBe(400);
});

// NUL byte dan lone surrogate nggak bisa disimpan postgres, jadi 400
test('NUL byte / UTF-16 rusak ditolak 400, bukan 500', async () => {
  const u = await buatUser('Karakter');

  expect((await api('POST', '/api/users', { name: 'a\u0000b', email: emailUnik() })).status).toBe(400);
  expect((await api('POST', '/api/users', { name: 'X', email: 'a\u0000@b.com' })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: 'a\u0000b' })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: 'ok', content: 'a\u0000' })).status).toBe(400);
  expect((await api('POST', '/api/notes', { user_id: u.id, title: 'ok', category: '\u0000' })).status).toBe(400);
  expect((await api('GET', '/api/notes?q=%00')).status).toBe(400);
  expect((await api('GET', '/api/users?q=%00')).status).toBe(400);

  // lone surrogate tidak boleh disimpan sebagai U+FFFD diam-diam
  expect((await api('POST', '/api/users', { name: 'a\ud800b', email: emailUnik() })).status).toBe(400);

  // teks non-ASCII yang sah tetap diterima apa adanya
  const unicode = await api('POST', '/api/users', { name: 'Ünïcødé 🎉', email: emailUnik() });
  expect(unicode.status).toBe(201);
  expect(unicode.data.name).toBe('Ünïcødé 🎉');
});

// static UI nggak boleh ikut CWD
test('UI tetap dilayani walau CWD bukan root repo', async () => {
  const cwdAwal = process.cwd();
  process.chdir('/tmp');
  try {
    const app2 = createApp({ query: async () => ({ rows: [] }) });
    const s2 = await new Promise((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });
    const res = await fetch(`http://localhost:${s2.address().port}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    s2.close();
  } finally {
    process.chdir(cwdAwal);
  }
});

// panjang dihitung per grapheme: 1 emoji = 1 karakter
test('emoji dihitung 1 karakter, bukan 2', async () => {
  const nama = '🎉'.repeat(100); // 100 karakter (200 code unit UTF-16)
  const ok = await api('POST', '/api/users', { name: nama, email: emailUnik('emoji') });
  expect(ok.status).toBe(201);
  expect(ok.data.name).toBe(nama);

  expect((await api('POST', '/api/users', { name: '🎉'.repeat(101), email: emailUnik() })).status).toBe(400);
  // emoji dengan modifikasi (grapheme cluster) tetap dihitung 1
  const cluster = '👨‍👩‍👧‍👦'.repeat(100);
  const okCluster = await api('POST', '/api/users', { name: cluster, email: emailUnik('cluster') });
  expect(okCluster.status).toBe(201);
  expect(okCluster.data.name).toBe(cluster);
});

// POST/PUT note balikin bentuk yang sama kayak GET (bawa user_name/user_email)
test('POST/PUT note mengembalikan user_name dan user_email seperti GET', async () => {
  const u = await buatUser('Bentuk Respons', emailUnik('shape'));
  const created = await api('POST', '/api/notes', { user_id: u.id, title: 'bentuk' });
  expect(created.status).toBe(201);
  expect(created.data.user_name).toBe('Bentuk Respons');
  expect(created.data.user_email).toBe(u.email);

  const got = await api('GET', `/api/notes/${created.data.id}`);
  expect(got.data).toEqual(created.data);

  const upd = await api('PUT', `/api/notes/${created.data.id}`, { title: 'bentuk baru' });
  expect(upd.status).toBe(200);
  expect(upd.data.user_name).toBe('Bentuk Respons');
  expect(upd.data.user_email).toBe(u.email);
});

// header keamanan, rate limit, API key opsional
const appDenganOpsi = async (opsi) => {
  const app2 = createApp(db.pool, opsi);
  const s = await new Promise((resolve) => {
    const srv = app2.listen(0, () => resolve(srv));
  });
  return { server: s, base: `http://localhost:${s.address().port}` };
};

test('respons membawa header keamanan dan tanpa X-Powered-By', async () => {
  const res = await fetch(base + '/api/users');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(res.headers.get('x-powered-by')).toBeNull();

  // UI statis ikut kena header yang sama
  const ui = await fetch(base + '/index.html');
  expect(ui.headers.get('x-frame-options')).toBe('DENY');
});

test('rate limit per IP: 429 JSON + Retry-After setelah batas', async () => {
  const { server: s2, base: b2 } = await appDenganOpsi({
    apiKey: '',
    rateLimit: { max: 2, windowMs: 60_000 },
  });
  try {
    expect((await fetch(b2 + '/api/users')).status).toBe(200);
    const kedua = await fetch(b2 + '/api/users');
    expect(kedua.status).toBe(200);
    expect(kedua.headers.get('x-ratelimit-remaining')).toBe('0');

    const ketiga = await fetch(b2 + '/api/users');
    expect(ketiga.status).toBe(429);
    expect(ketiga.headers.get('retry-after')).toBeTruthy();
    expect(ketiga.headers.get('content-type')).toContain('application/json');
    expect((await ketiga.json()).error).toBeTruthy();
  } finally {
    s2.close();
  }

  // max <= 0 mematikan rate limit (dipakai kalau di belakang reverse proxy)
  const { server: s3, base: b3 } = await appDenganOpsi({
    apiKey: '',
    rateLimit: { max: 0, windowMs: 60_000 },
  });
  try {
    for (let i = 0; i < 5; i++) expect((await fetch(b3 + '/api/users')).status).toBe(200);
  } finally {
    s3.close();
  }
});

// windowMs nggak dikirim jangan bikin interval 0ms (loop tanpa jeda)
test('rate limit tanpa windowMs tetap jalan (default 60 detik)', async () => {
  const { server: s, base: b } = await appDenganOpsi({ apiKey: '', rateLimit: { max: 2 } });
  try {
    expect((await fetch(b + '/api/users')).status).toBe(200);
    expect((await fetch(b + '/api/users')).status).toBe(200);
    const ketiga = await fetch(b + '/api/users');
    expect(ketiga.status).toBe(429);
    expect(ketiga.headers.get('retry-after')).toBeTruthy();
    const retry = Number(ketiga.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  } finally {
    s.close();
  }
});

test('API_KEY kalau diset: tulis wajib header, baca tetap bebas', async () => {
  const { server: s2, base: b2 } = await appDenganOpsi({
    apiKey: 'rahasia123',
    rateLimit: { max: 0, windowMs: 60_000 },
  });
  const kirim = (headers = {}) =>
    fetch(b2 + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'Kunci', email: emailUnik('kunci') }),
    });
  try {
    expect((await fetch(b2 + '/api/users')).status).toBe(200); // GET tanpa key tetap boleh
    expect((await kirim()).status).toBe(401);
    expect((await kirim({ Authorization: 'Bearer salah' })).status).toBe(401);
    expect((await kirim({ 'x-api-key': 'rahasia123' })).status).toBe(201);
    expect((await kirim({ Authorization: 'Bearer rahasia123' })).status).toBe(201);
  } finally {
    s2.close();
  }
});
