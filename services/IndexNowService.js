/**
 * IndexNowService
 * ---------------
 * Klient IndexNow API — protokół wspierany przez Bing, Yandex, DuckDuckGo
 * (Google obecnie nie jest oficjalnym uczestnikiem, ale Bing + Yandex
 *  i tak indeksują szybciej, a DuckDuckGo bazuje na Bingu).
 *
 * Po publikacji / przebudowie strony wysyłamy URL do IndexNow → typowo
 * indeksacja w ciągu kilku godzin (vs. tygodnie standardowo).
 *
 * Wymaga:
 *   - INDEXNOW_KEY (UUID/hex, 8–128 znaków) w env
 *   - URL `https://helpfli.pl/<INDEXNOW_KEY>.txt` zwraca tę samą wartość
 *     → osiągamy to przez backend route w `routes/seo.js`
 *
 * Wszystkie wywołania są fire-and-forget i nie blokują requesta usera.
 */

const https = require('https');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

const ENDPOINT_HOST = 'api.indexnow.org';
const ENDPOINT_PATH = '/IndexNow';
const SEARCH_ENGINE_HOST = 'www.bing.com'; // można też wskazać konkretny silnik

function getKey() {
  return (process.env.INDEXNOW_KEY || '').trim();
}

function getHost() {
  try {
    const url = new URL(process.env.SEO_PUBLIC_BASE_URL || 'https://helpfli.pl');
    return url.host;
  } catch {
    return 'helpfli.pl';
  }
}

function isEnabled() {
  if (process.env.INDEXNOW_ENABLED && process.env.INDEXNOW_ENABLED !== '1') return false;
  return getKey().length >= 8;
}

/**
 * Wyślij pojedynczy URL (sygnał świeżej / nowej strony).
 * @param {string} url – pełny URL https://...
 */
async function submit(url) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: 'IndexNow disabled / no key' };
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' };

  const key = getKey();
  const host = getHost();

  // Single-URL endpoint (GET) – najlżejszy
  const fullUrl =
    `https://${SEARCH_ENGINE_HOST}/indexnow?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}`;

  return new Promise((resolve) => {
    https
      .get(fullUrl, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        logger.info?.(`[IndexNow] ${url} → ${res.statusCode}`);
        res.resume();
        resolve({ ok, status: res.statusCode });
      })
      .on('error', (err) => {
        logger.warn?.('[IndexNow] submit failed:', err.message);
        resolve({ ok: false, error: err.message, host });
      });
  });
}

/**
 * Bulk submission (do 10000 URLi w jednym requeście) – via POST JSON.
 */
async function submitBatch(urls = []) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const filtered = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, 10000);
  if (!filtered.length) return { ok: false, error: 'no urls' };

  const key = getKey();
  const host = getHost();
  const body = JSON.stringify({
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: filtered
  });

  const options = {
    method: 'POST',
    host: ENDPOINT_HOST,
    path: ENDPOINT_PATH,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 8000
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      logger.info?.(`[IndexNow] batch (${filtered.length} URLs) → ${res.statusCode}`);
      res.resume();
      resolve({ ok, status: res.statusCode, count: filtered.length });
    });
    req.on('error', (err) => {
      logger.warn?.('[IndexNow] batch failed:', err.message);
      resolve({ ok: false, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Handler dla `/{KEY}.txt` – wymagana publicznie weryfikacja własności domeny.
 *  - jeśli `req.params.key` === naszemu kluczowi → zwracamy klucz tekstowo
 *  - w przeciwnym razie 404
 */
function keyFileHandler(req, res) {
  const key = getKey();
  if (!key) return res.status(404).send('IndexNow disabled');
  const requested = String(req.params.key || '').replace(/\.txt$/i, '');
  if (requested !== key) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(key);
}

module.exports = {
  isEnabled,
  submit,
  submitBatch,
  keyFileHandler
};
