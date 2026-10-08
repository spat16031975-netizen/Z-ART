// Z-Art: отдаёт сайт (index.html) и пересылает заявки, заказы, отзывы и фото в Telegram.
// Токен бота и chat_id берутся из переменных Railway: BOT_TOKEN и CHAT_ID. В коде сайта их нет.
//
// Защита:
//  • файлы проверяются по содержимому, а не по имени: «картинка», внутри которой HTML, скрипт или программа,
//    не будет ни переслана в Telegram, ни отдана посетителям;
//  • в Telegram уходят только разрешённые поля, адресат (chat_id) подменить нельзя;
//  • наружу отдаются только сайт, .txt и проверенные картинки; код сервера и настройки недоступны;
//  • запросы принимаются только со своих адресов сайта, есть ограничение частоты и размера;
//  • у всех ответов защитные заголовки (запрет подмены типа, встраивания в чужие сайты и т. п.).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const TG_API = process.env.TG_API || 'https://api.telegram.org';
// Адреса, с которых сайт может отправлять заявки. Можно переопределить переменной ALLOWED_ORIGINS через запятую.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://z-art-production.up.railway.app,https://spat16031975-netizen.github.io')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

const MAX_BODY = 20 * 1024 * 1024;              // общий размер запроса
const MAX_PHOTO = 10 * 1024 * 1024;             // sendPhoto
const MAX_DOC = 16 * 1024 * 1024;               // sendDocument (фото для картины по фото до 15 МБ)
const LIMIT = 30, WINDOW = 10 * 60 * 1000;      // не больше 30 отправок с одного адреса за 10 минут
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.html');

// ---------- проверка файлов по содержимому («магические байты») ----------
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.toString('latin1', 8, 12))) return 'heic';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  return null;
}
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', ico: 'image/x-icon' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic', ico: 'ico' };
// Что можно отдавать посетителям: расширение → какой тип должен оказаться внутри.
const STATIC_IMG = { '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.png': ['png'], '.webp': ['webp'], '.ico': ['ico', 'png'] };

// ---------- что разрешено пересылать в Telegram ----------
const RULES = {
  sendMessage: { text: ['text', 4096], fields: { parse_mode: v => v === 'HTML', disable_web_page_preview: v => v === 'true' || v === 'false' } },
  sendPhoto: { text: ['caption', 1024], file: 'photo', types: ['jpeg', 'png'], max: MAX_PHOTO },
  sendDocument: { text: ['caption', 1024], file: 'document', types: ['jpeg', 'png', 'heic'], max: MAX_DOC }
};

const hits = new Map();
function allowed(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (list.length >= LIMIT) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some(t => now - t < WINDOW)) hits.delete(ip); }, WINDOW).unref();

// ---------- заголовки ----------
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000'
};
const PAGE_CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self' data: blob: https://z-art-production.up.railway.app",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'"
].join('; ');
const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

function cors(req) {
  const o = (req.headers.origin || '').replace(/\/$/, '');
  return ALLOWED_ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : { 'Vary': 'Origin' };
}
function json(req, res, code, obj) {
  res.writeHead(code, { ...BASE_HEADERS, ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function notFound(res) {
  res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Not found');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const bad = (code, msg) => Object.assign(new Error(msg), { code });

// Разбор multipart/form-data без сторонних библиотек.
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw bad(400, 'no boundary');
  const delim = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = []; let pos = buf.indexOf(delim);
  if (pos < 0) throw bad(400, 'bad multipart');
  while (true) {
    pos += delim.length;
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // \r\n
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw bad(400, 'bad multipart');
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4);
    if (next < 0) throw bad(400, 'bad multipart');
    const data = buf.slice(headEnd + 4, next - 2);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1];
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
    if (name) parts.push({ name, filename, data });
    if (parts.length > 10) throw bad(400, 'too many fields');
    pos = next;
  }
  return parts;
}

// Собирает «чистый» запрос в Telegram только из разрешённых полей.
function buildTelegramBody(method, req, body) {
  const rule = RULES[method];
  const type = (req.headers['content-type'] || '').toLowerCase();
  if (method === 'sendMessage') {
    if (!type.startsWith('application/x-www-form-urlencoded')) throw bad(415, 'wrong content type');
    const inp = new URLSearchParams(body.toString('utf8')), out = new URLSearchParams();
    const text = inp.get('text') || '';
    if (!text.trim() || text.length > rule.text[1]) throw bad(400, 'bad text');
    out.set('text', text);
    for (const [k, ok] of Object.entries(rule.fields)) { const v = inp.get(k); if (v != null && ok(v)) out.set(k, v); }
    out.set('chat_id', CHAT_ID); // адресат всегда наш, что бы ни прислали
    return { body: out, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  }
  if (!type.startsWith('multipart/form-data')) throw bad(415, 'wrong content type');
  const parts = parseMultipart(body, req.headers['content-type']);
  const filePart = parts.find(p => p.name === rule.file && p.filename !== undefined);
  if (!filePart || !filePart.data.length) throw bad(400, 'no file');
  if (filePart.data.length > rule.max) throw bad(413, 'file too large');
  const kind = sniff(filePart.data);
  if (!kind || !rule.types.includes(kind)) throw bad(415, 'file is not an allowed image');
  const fd = new FormData();
  fd.append('chat_id', CHAT_ID);
  const cap = parts.find(p => p.name === rule.text[0] && p.filename === undefined);
  if (cap) fd.append(rule.text[0], cap.data.toString('utf8').slice(0, rule.text[1]));
  const base = (filePart.filename || 'photo').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'photo';
  fd.append(rule.file, new Blob([filePart.data], { type: MIME[kind] }), `${base}.${EXT[kind]}`); // расширение по содержимому
  return { body: fd, headers: {} };
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return notFound(res); }
  const m = url.pathname.match(/^\/api\/tg\/(\w+)$/);

  if (m) {
    const origin = (req.headers.origin || '').replace(/\/$/, '');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(req, res, 403, { ok: false, error: 'origin not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...BASE_HEADERS, ...cors(req) }); return res.end(); }
    if (req.method !== 'POST' || !RULES[m[1]]) return json(req, res, 404, { ok: false, error: 'not found' });
    if (!BOT_TOKEN || !CHAT_ID) return json(req, res, 503, { ok: false, error: 'BOT_TOKEN or CHAT_ID is not set' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowed(ip)) return json(req, res, 429, { ok: false, error: 'too many requests' });
    try {
      const raw = await readBody(req);
      const clean = buildTelegramBody(m[1], req, raw);
      const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${m[1]}`, { method: 'POST', headers: clean.headers, body: clean.body });
      if (!r.ok) console.error('Telegram error', r.status, (await r.text()).slice(0, 300));
      return json(req, res, r.ok ? 200 : 502, { ok: r.ok });
    } catch (e) {
      if (e.code) { console.warn('Rejected', m[1], ip, e.message); return json(req, res, e.code, { ok: false, error: e.message }); }
      console.error('Send failed:', e.message);
      return json(req, res, 502, { ok: false });
    }
  }

  if (url.pathname === '/health') return json(req, res, 200, { ok: true, telegram: !!(BOT_TOKEN && CHAT_ID) });

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD, POST' }); return res.end(); }

  if (url.pathname === '/robots.txt') { res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('User-agent: *\nAllow: /\n'); }

  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch (e) { return notFound(res); }
  if (/(^|\/)\./.test(decoded)) return notFound(res); // скрытые файлы вроде .env или .git
  const ext = path.extname(decoded).toLowerCase();
  if (ext) {
    // Только файлы из корня, без скрытых, без папок и обходов вроде ../
    const name = path.basename(decoded);
    if (!name || name !== decoded.replace(/^\/+/, '') || name.startsWith('.') || /[\\\0]/.test(name)) return notFound(res);
    const file = path.join(ROOT, name);
    if (ext === '.txt') {
      return fs.readFile(file, (err, data) => {
        if (err || data.includes(0)) return notFound(res); // в текстовом файле не должно быть двоичных данных
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': FILE_CSP, 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    }
    const expected = STATIC_IMG[ext];
    if (!expected) return notFound(res);
    return fs.readFile(file, (err, data) => {
      if (err) return notFound(res);
      const kind = sniff(data);
      if (!kind || !expected.includes(kind)) { console.warn('Blocked disguised file', name); return notFound(res); } // «картинка», которая на деле не картинка
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[kind], 'Content-Security-Policy': FILE_CSP, 'Cache-Control': 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  // Любой другой адрес отдаёт сайт: он одностраничный, ссылки вида ?item=paint-001 тоже работают.
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('index.html не найден рядом с server.js'); }
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.listen(PORT, () => console.log(`Z-Art работает на порту ${PORT}. Telegram: ${BOT_TOKEN && CHAT_ID ? 'настроен' : 'НЕ настроен (задай BOT_TOKEN и CHAT_ID)'}`));
