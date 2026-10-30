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
| PUT | `/api/users/:id` | edit user (parsial) |
| DELETE | `/api/users/:id` | hapus user, note-nya ikut |
| GET | `/api/notes?q=&category=&user_id=&limit=&offset=` | daftar note + filter |
| GET | `/api/notes/categories` | daftar kategori yang ada |
| GET | `/api/notes/:id` | detail note |
| POST | `/api/notes` | tambah note |
| PUT | `/api/notes/:id` | edit note, bisa pindah pemilik |
| DELETE | `/api/notes/:id` | hapus note |

Catatan perilaku:

- Semua respons note bentuknya sama (ada `user_name` dan `user_email`), termasuk
  balasan POST/PUT, biar frontend nggak perlu GET lagi abis nyimpen.
- `limit` 1–500, `offset` >= 0. Tanpa `limit` semua baris keluar.
- `id` dan `user_id` harus angka bulat positif.
- Batas panjang: `name` 100, `email` 200, `title` 200, `content` 10000,
  `category` 50.
- Error di `/api/*` selalu JSON `{ "error": "..." }`. Endpoint yang nggak ada
  juga 404 JSON, bukan halaman HTML bawaan Express.

## Env

| Env | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | port HTTP |
| `PG_PORT` | `5433` | port Postgres |
| `PG_PASSWORD` | `devpassword` | password user `postgres` |
| `PG_DATA_DIR` | `data/db` | lokasi cluster |
| `API_KEY` | _(kosong)_ | kalau diisi, request tulis wajib bawa key |
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
