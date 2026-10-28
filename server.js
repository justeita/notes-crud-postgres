import { startDatabase } from './db.js';
import { createApp } from './app.js';

const HTTP_PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';

const db = await startDatabase();
const app = createApp(db.pool);

if (!API_KEY) {
  console.log(
    'Catatan: API_KEY tidak diset, siapa pun yang bisa menjangkau port ini boleh mengubah data.'
  );
}

const server = app.listen(HTTP_PORT, () => {
  console.log(`App jalan di http://localhost:${HTTP_PORT}`);
});
