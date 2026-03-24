?// backend/services/llm_local.js
const axios = require('axios');
const crypto = require('crypto');

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl';

// Prosty cache w pamięci (w produkcji użyj Redis)
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minut

async function fetchToBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(res.data).toString('base64');
}

function buildPrompt(description, lang) {
  const L = (lang || 'pl').toLowerCase().startsWith('en') ? 'en' : 'pl';
  const instrPL = `
Jesteś przyjaznym ekspertem serwisowym Helpfli. Analizujesz problemy domowe i pomagasz użytkownikom.

Na podstawie opisu problemu zwróć WYŁĄCZNIE JSON (bez komentarzy, bez backticków) o schemacie:
{
  "language": "pl",
  "dangerFlags": ["electricity"|"gas"|"water"],
  "diySteps": ["praktyczny krok 1", "praktyczny krok 2", ...],
  "parts": [{"name":"nazwa części", "qty":1, "approxPrice": 10, "unit":"PLN"}],
  "serviceCandidate": {"code":"slug_usługi", "confidence": 0.8}
}

Zasady:
- "dangerFlags": ustaw ["electricity"] jeśli problem z prądem, ["gas"] jeśli z gazem, ["water"] jeśli wyciek wody
- "diySteps": 3-5 praktycznych kroków, które użytkownik może zrobić sam. Bądź konkretny i pomocny.
- "parts": tylko najpotrzebniejsze części do naprawy
- "serviceCandidate.code": użyj prostego sluga (np. "hydraulik_kran", "elektryk_gniazdko", "agd_pralka")
- Bądź praktyczny i pomocny, nie teoretyczny

OPIS PROBLEMU:\n${description}\n`;
  
  const instrEN = `
You are a friendly home repair expert from Helpfli. You analyze home problems and help users.

Based on the problem description, return ONLY JSON (no comments/backticks) with:
{
  "language": "en",
  "dangerFlags": ["electricity"|"gas"|"water"],
  "diySteps": ["practical step 1", "practical step 2", ...],
  "parts": [{"name":"part name", "qty":1, "approxPrice": 10, "unit":"PLN"}],
  "serviceCandidate": {"code":"service_slug", "confidence": 0.8}
}

Rules:
- "dangerFlags": set ["electricity"] for electrical issues, ["gas"] for gas issues, ["water"] for water leaks
- "diySteps": 3-5 practical steps the user can do themselves. Be specific and helpful.
- "parts": only essential parts needed for repair
- "serviceCandidate.code": use simple slug (e.g. "plumber_faucet", "electrician_outlet", "appliance_washer")
- Be practical and helpful, not theoretical

PROBLEM DESCRIPTION:\n${description}\n`;
  
  return L === 'en' ? instrEN : instrPL;
}

function safeParseJSON(txt) {
  try { return JSON.parse(txt); } catch {}
  // Spróbuj wyciąć blok JSON
  const m = txt.match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function analyzeWithOllama({ description, imageUrls = [], lang = 'pl' }) {
  // Sprawdź cache
  const cacheKey = crypto.createHash('md5').update(`${description}-${lang}`).digest('hex');
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('AI Cache HIT for:', description.substring(0, 50) + '...');
    return cached.data;
  }

  const images = [];
  for (const u of imageUrls.slice(0, 4)) {
    try { 
      // Konwertuj relative URL na pełny URL jeśli potrzeba
      const fullUrl = u.startsWith('http') ? u : `${process.env.SERVER_URL || 'http://localhost:5000'}${u}`;
      images.push(await fetchToBase64(fullUrl)); 
    } catch (error) {
      console.error('Error fetching image:', u, error.message);
    }
  }

  const payload = {
    model: OLLAMA_MODEL,
    prompt: buildPrompt(description || '', lang),
    images: images.length ? images : undefined,
    stream: false,
    // Parametry optymalizacji dla szybkości
    temperature: 0.1,        // Niższa temperatura = szybsze, bardziej deterministyczne odpowiedzi
    num_ctx: 2048,          // Mniejszy kontekst = szybsze przetwarzanie
    num_predict: 512,       // Ograniczenie długości odpowiedzi
    top_k: 20,              // Ograniczenie wyboru tokenów
    top_p: 0.8,             // Ograniczenie prawdopodobieństwa
    repeat_penalty: 1.1,    // Zapobieganie powtórzeniom
    stop: ["```", "JSON", "```json"] // Zatrzymanie na końcu JSON
  };

  try {
    const res = await axios.post(`${OLLAMA_URL}/api/generate`, payload, { timeout: 30000 }); // 30 sekund
    const out = typeof res.data === 'string' ? res.data : res.data.response || res.data.message || '';
    const parsed = safeParseJSON(out) || {};
    
    // Fallbacky
    const result = {
      language: parsed.language || (lang.toLowerCase().startsWith('en') ? 'en' : 'pl'),
      dangerFlags: Array.isArray(parsed.dangerFlags) ? parsed.dangerFlags : [],
      diySteps: Array.isArray(parsed.diySteps) ? parsed.diySteps : [],
      parts: Array.isArray(parsed.parts) ? parsed.parts : [],
      serviceCandidate: parsed.serviceCandidate || null
    };

    // Zapisz w cache
    responseCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    // Oczyść stary cache (max 100 wpisów)
    if (responseCache.size > 100) {
      const oldestKey = responseCache.keys().next().value;
      responseCache.delete(oldestKey);
    }

    return result;
  } catch (error) {
    console.error('Ollama API error:', error.message);
    throw error;
  }
}

module.exports = { analyzeWithOllama };
