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
