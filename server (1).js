// Z-Art: отдаёт сайт (index.html) и пересылает заявки и заказы в Telegram.
// Токен бота и chat_id берутся из переменных Railway: BOT_TOKEN и CHAT_ID. В коде сайта их нет.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const METHODS = new Set(['sendMessage', 'sendDocument', 'sendPhoto']);
const MAX_BODY = 20 * 1024 * 1024;   // 20 МБ: с запасом на фото до 15 МБ
const LIMIT = 30, WINDOW = 10 * 60 * 1000; // не больше 30 сообщений с одного адреса за 10 минут
const INDEX = path.join(__dirname, 'index.html');
const STATIC = { '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const hits = new Map();

function allowed(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (list.length >= LIMIT) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some(t => now - t < WINDOW)) hits.delete(ip); }, WINDOW).unref();

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/tg\/(\w+)$/);

  if (m) {
    if (req.method !== 'POST' || !METHODS.has(m[1])) return json(res, 404, { ok: false, error: 'not found' });
    if (!BOT_TOKEN || !CHAT_ID) return json(res, 503, { ok: false, error: 'BOT_TOKEN or CHAT_ID is not set' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowed(ip)) return json(res, 429, { ok: false, error: 'too many requests' });
    try {
      const body = await readBody(req);
      const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${m[1]}?chat_id=${encodeURIComponent(CHAT_ID)}`, {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' },
        body
      });
      if (!r.ok) console.error('Telegram error', r.status, (await r.text()).slice(0, 300));
      return json(res, r.ok ? 200 : 502, { ok: r.ok });
    } catch (e) {
      console.error('Send failed:', e.message);
      return json(res, e.message === 'too large' ? 413 : 502, { ok: false });
    }
  }

  if (url.pathname === '/health') return json(res, 200, { ok: true, telegram: !!(BOT_TOKEN && CHAT_ID) });

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('User-agent: *\nAllow: /\n'); }
    // Файлы рядом с сайтом: reviews.txt и фото отзывов. Код сервера и настройки наружу не отдаём.
    const ext = path.extname(url.pathname).toLowerCase();
    if (ext) {
      const type = STATIC[ext];
      let name = '';
      try { name = path.basename(decodeURIComponent(url.pathname)); } catch (e) { /* кривой адрес */ }
      if (!type || !name || name.startsWith('.')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      return fs.readFile(path.join(__dirname, name), (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.txt' ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    }
    // Любой другой адрес отдаёт сайт: он одностраничный, ссылки вида ?item=paint-001 тоже работают.
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html не найден рядом с server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
    return;
  }
  json(res, 405, { ok: false });
});

server.listen(PORT, () => console.log(`Z-Art работает на порту ${PORT}. Telegram: ${BOT_TOKEN && CHAT_ID ? 'настроен' : 'НЕ настроен (задай BOT_TOKEN и CHAT_ID)'}`));
