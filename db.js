import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1 user punya banyak notes
CREATE TABLE IF NOT EXISTS notes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'umum',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes(user_id);
CREATE INDEX IF NOT EXISTS notes_category_idx ON notes(category);
`;

export async function startDatabase({
  databaseDir = process.env.PG_DATA_DIR
    ? path.resolve(process.env.PG_DATA_DIR)
    : path.join(__dirname, 'data', 'db'),
  port = Number(process.env.PG_PORT || 5433),
  user = 'postgres',
  password = process.env.PG_PASSWORD || 'devpassword',
  database = 'app',
  verbose = true,
} = {}) {
  const log = verbose ? console.log : () => {};

  const onLog = (line) => {
    const msg = String(line).trim();
    if (msg && verbose) console.log('[postgres]', msg);
  };

  const server = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    authMethod: 'password',
    persistent: true,
    onLog,
    onError: (msg) => console.error('[postgres]', msg),
  });

  // init cluster cuma sekali, pas datadir-nya belum ada
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    log('Inisialisasi cluster PostgreSQL baru...');
    await server.initialise();
  }

  await server.start();

  // nama database nggak bisa diparameterisasi di DDL, jadi divalidasi dulu
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    await server.stop();
    throw new Error(`Nama database tidak valid: ${JSON.stringify(database)}`);
  }

  const pool = new pg.Pool({ host: 'localhost', port, user, password, database });

  // pg buang idle client yang error; tanpa listener ini, event 'error' yang
  // nggak ketangkep bikin seluruh proses mati, bukan cuma satu request
  pool.on('error', (err) => {
    console.error('[pg pool] idle client error:', err.message);
  });

  const admin = server.getPgClient('postgres');
  try {
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    // tanpa finally, client admin bocor (postgres-nya juga ikut hidup) kalau
    // CREATE DATABASE gagal
    await admin.end().catch(() => {});
  }

  await pool.query(SCHEMA_SQL);

  return {
    pool,
    async stop() {
      await pool.end();
      await server.stop();
    },
  };
}
