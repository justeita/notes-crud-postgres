# Notes CRUD

Aplikasi CRUD catatan (user + note) pakai PostgreSQL beneran, bukan array di
memori. Jadi datanya masih ada abis refresh maupun abis server di-restart.

## Stack

- Bun (runtime + test runner)
- Express 5
- PostgreSQL 18 lewat package `embedded-postgres`, jadi nggak perlu install
  Postgres di sistem, clusternya dijalanin dari dalam proses Node

## Cara jalanin

```bash
bun install
bun run start
```

Buka http://localhost:3000. Kalau mau auto-reload pas ngoding:

```bash
bun run dev
```

Test:

```bash
bun run test
```

Test pakai cluster sendiri di `data/test-db` dengan port acak, jadi nggak
bentrok sama server dev (5433) dan nggak ngotorin data development.

## Skema

```
users 1 ---< notes
```

- `notes.user_id` -> `users.id`, `ON DELETE CASCADE` (hapus user, note-nya ikut)
- `users.email` UNIQUE
- index biasa di `notes.user_id` dan `notes.category`
- index trigram (`pg_trgm`) di kolom yang dipakai `ILIKE '%kata%'`: `users.name`,
  `users.email`, `notes.title`, `notes.content`. Kalau build Postgres-nya nggak
  punya `pg_trgm`, startup tetap jalan, cuma pencariannya jadi lebih lambat
  (dicatat di log).

## Endpoint

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/api/users?q=&limit=&offset=` | daftar user + jumlah note-nya |
| GET | `/api/users/:id` | detail user |
| POST | `/api/users` | tambah user |
| PUT | `/api/users/:id` | edit (parsial) |
| DELETE | `/api/users/:id` | hapus user, note-nya ikut |
| GET | `/api/notes?q=&category=&user_id=&limit=&offset=` | daftar note + filter |
| GET | `/api/notes/categories` | daftar kategori yang ada |
| GET | `/api/notes/:id` | detail note |
| POST | `/api/notes` | tambah note |
| PUT | `/api/notes/:id` | edit (parsial, bisa pindah pemilik) |
| DELETE | `/api/notes/:id` | hapus note |

Catatan perilaku:

- `PUT` itu parsial. Kirim field yang mau diubah aja, sisanya dibiarkan. Jadi
  `PUT {"title": "..."}` nggak menghapus `content`. `content: ""` tetap sah
  (memang mau dikosongin). Request tanpa field apa pun dibalas 400.
- Semua respons note bentuknya sama (ada `user_name` dan `user_email`), termasuk
  balasan POST/PUT, biar frontend nggak perlu GET lagi abis nyimpen.
- `limit` 1–500, `offset` >= 0. Tanpa `limit` semua baris keluar.
- `id` dan `user_id` harus integer positif. `"abc"`, `true`, `"1e0"`, `"0x10"`
  ditolak 400, nggak dikoersi jadi angka.
- Input kepanjangan ditolak 400, bukan dipotong diam-diam: `name` 100,
  `email` 200, `title` 200, `content` 10000, `category` 50.
- Error di `/api/*` selalu JSON `{ "error": "..." }`. Endpoint yang nggak ada
  juga 404 JSON, bukan halaman HTML bawaan Express.

## Keamanan

Ini project tugas, jadi yang dipasang cuma yang murah dan nggak bikin ribet:

- header `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, dan CSP
  `default-src 'self'` (nggak ada `unsafe-inline`; tombol pakai event delegation)
- `X-Powered-By` dimatikan
- rate limit per IP di memori: 600 request/menit buat `/api/*`, lewat itu 429
- `API_KEY` opsional. Kalau diisi, POST/PUT/DELETE wajib kirim `x-api-key` atau
  `Authorization: Bearer <key>`. GET tetap bebas. UI-nya belum ngirim key, jadi
  kalau `API_KEY` diset tombol Simpan/Hapus di web bakal 401. Buat demo lokal
  mending biarin kosong.

Belum ada: login per user, CSRF token, dan rate limit yang tahan multi-proses.
Kalau dipasang di belakang reverse proxy, `req.ip` itu IP proxy, jadi set
`RATE_LIMIT=0` terus batasi di proxy-nya.

## Env

| Env | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | port HTTP |
| `PG_PORT` | `5433` | port Postgres |
| `PG_PASSWORD` | `devpassword` | password user `postgres` |
| `PG_DATA_DIR` | `data/db` | lokasi cluster |
| `API_KEY` | _(kosong)_ | kalau diisi, tulis wajib pakai key |
| `RATE_LIMIT` | `600` | request `/api/*` per IP per menit, `0` = mati |

Bun otomatis baca `.env` di root, jadi kredensial bisa ditaruh di situ:

```bash
printf 'PG_PASSWORD=passwordku\n' > .env
```

`.env` sama `data/` udah masuk `.gitignore`.

## Reset database

Matikan server dulu (Ctrl+C), baru hapus direktori datanya. Kalau dihapus pas
cluster-nya masih hidup, Postgres-nya error dan data dir-nya bisa setengah rusak.

```bash
rm -rf data/db
```

Cluster dan tabelnya dibikin ulang otomatis pas server dijalankan lagi.
