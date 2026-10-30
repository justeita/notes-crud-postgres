import { startDatabase } from './db.js';
import { createApp } from './app.js';

const HTTP_PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';

const db = await startDatabase();
// rate limit default 600 req/menit per IP, RATE_LIMIT=0 buat matiin
const app = createApp(db.pool, { apiKey: API_KEY });

if (!API_KEY) {
  console.log(
    'Catatan: API_KEY tidak diset, siapa pun yang bisa menjangkau port ini boleh mengubah data.'
  );
}

const server = app.listen(HTTP_PORT, () => {
  console.log(`App jalan di http://localhost:${HTTP_PORT}`);
});

let closing = false;

async function shutdown(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} diterima, mematikan server...`);

  // tutup listener dulu, baru pool-nya, biar request yang lagi jalan nggak
  // kepotong di tengah
  await new Promise((resolve) => {
    server.close(resolve);
    // keep-alive bisa nahan close() selamanya, jadi dipaksa putus abis 5 detik
    setTimeout(() => server.closeAllConnections?.(), 5000).unref();
  });

  await db.stop().catch((err) => console.error('Gagal stop database:', err.message));
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
