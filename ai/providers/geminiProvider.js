/**
 * Google Gemini API (JSON) — tani tier dla klasyfikacji i prostych odpowiedzi
 */

const axios = require('axios');
const { safeParseJSON } = require('../utils/jsonParse');

const JSON_SUFFIX = `

KRYTYCZNE: Odpowiedz WYŁĄCZNIE w formacie JSON. Nie dodawaj żadnego tekstu przed ani po JSON.
JSON powinien być poprawny, parsowalny, bez dodatkowych znaków, bez markdown code blocks.
Zacznij odpowiedź bezpośrednio od { i zakończ na }.`;

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
}

function getCheapModel() {
  return process.env.AI_CHEAP_MODEL || 'gemini-2.0-flash';
}

function toGeminiContents(messages = []) {
  const normalized = messages
    .filter((m) => m && m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : (m.text || '') }]
    }))
    .filter((m) => m.parts[0].text.trim().length > 0);

  const merged = [];
  for (const msg of normalized) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.parts[0].text = `${last.parts[0].text}\n\n${msg.parts[0].text}`;
    } else {
      merged.push({ ...msg, parts: [{ text: msg.parts[0].text }] });
    }
  }

  if (merged[0]?.role === 'model') {
    merged.shift();
  }

  return merged;
}

/**
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {string} [model]
 * @returns {Promise<Object>}
 */
async function callGeminiJSON(systemPrompt, messages, model) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found');
  }

  const modelId = model || getCheapModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  const { data } = await axios.post(
    url,
    {
      systemInstruction: { parts: [{ text: `${systemPrompt}${JSON_SUFFIX}` }] },
      contents: toGeminiContents(messages),
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json'
      }
    },
    {
      params: { key: apiKey },
      timeout: Number(process.env.AI_REQUEST_TIMEOUT_MS) || 60000,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    const blockReason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(`Gemini empty response${blockReason ? ` (${blockReason})` : ''}`);
  }

  const parsed = safeParseJSON(text.trim());
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini did not return valid JSON');
  }

  return parsed;
}

function hasGeminiKey() {
  const key = getGeminiApiKey();
  return !!(key && key.trim().length > 10);
}

module.exports = {
  callGeminiJSON,
  getCheapModel,
  hasGeminiKey,
  getGeminiApiKey
};
