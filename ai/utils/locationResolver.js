/**
 * Lokalizacja do wyszukiwania wykonawców — tekst z rozmowy + opcjonalne geokodowanie
 */

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function pickCityFromText(text = '') {
  const t = String(text || '');
  const patterns = [
    /\b(?:w|we|na)\s+([A-ZĄĆĘŁŃÓŚŹŻ][\p{L}.' -]{2,40}(?:\s+\d+[A-Za-z]?)?)/u,
    /\b(warszaw[aęę]|krakowie|kraków|wrocławiu|wrocław|gdańsku|gdańsk|poznaniu|poznań|wilanowie|wilanów|łódź|lodzi)\b/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

async function geocodeCity(cityText) {
  const key = String(cityText || '').trim().toLowerCase();
  if (!key || key.length < 2) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.coords;

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', `${cityText}, Polska`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Helpfli/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const first = data?.[0];
    if (!first?.lat || !first?.lon) return null;
    const coords = { lat: parseFloat(first.lat), lng: parseFloat(first.lon), text: cityText };
    cache.set(key, { at: Date.now(), coords });
    return coords;
  } catch (err) {
    console.warn('[locationResolver] geocode failed:', err.message);
    return null;
  }
}

/**
 * @returns {{ text: string, lat: number|null, lng: number|null }}
 */
async function resolveProviderSearchLocation({
  userContext = {},
  draftLocation = null,
  messages = []
}) {
  const userText = (messages || [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content || m.text || '')
    .join('\n');

  const draftText =
    typeof draftLocation === 'object' ? draftLocation?.text || draftLocation?.address : draftLocation;

  let text =
    draftText ||
    userContext.location?.text ||
    (typeof userContext.location === 'string' ? userContext.location : null) ||
    pickCityFromText(userText) ||
    null;

  let lat = userContext.location?.lat ?? userContext.lat ?? null;
  let lng = userContext.location?.lng ?? userContext.lng ?? userContext.lon ?? null;

  if ((!lat || !lng) && text) {
    const geo = await geocodeCity(text);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      text = text || geo.text;
    }
  }

  return { text: text || '', lat: lat || null, lng: lng || null };
}

module.exports = {
  resolveProviderSearchLocation,
  pickCityFromText,
  geocodeCity
};
