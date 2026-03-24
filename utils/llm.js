// utils/llm.js
// Warstwa integracji z LLM. Wspiera OpenAI (jeśli masz OPENAI_API_KEY),
// a jeśli brak klucza — prosty fallback heurystyczny (działa od razu).

const OPENAI_ENABLED = !!process.env.OPENAI_API_KEY;

async function callOpenAI(system, user) {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini", // lekki, szybki; możesz zmienić na inny
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const txt = completion.choices?.[0]?.message?.content || "{}";
  return txt;
}

// Ostrożny parser JSON (naprawia typowe błędy).
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    // Spróbuj wyciąć największy blok {...}
    const first = str.indexOf("{");
    const last = str.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const slice = str.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {}
    }
  }
  return null;
}

// Minimalny fallback kategoryzacji bez LLM.
function heuristicExtract(problemText) {
  const txt = (problemText || "").toLowerCase();

  let service = "inne";
  if (/(pralka|agd|zmywarka|lod[oó]wka)/.test(txt)) service = "agd_pralka";
  else if (/(kran|hydraulik|rura|wc|zlew|sp[łl]uczka)/.test(txt)) service = "hydraulik_naprawa";
  else if (/(gniazd|bezpiecznik|pr[ąa]d|elektryk|kabel)/.test(txt)) service = "elektryk_naprawa";
  else if (/(piec|kaloryfer|grzejnik|co|gaz)/.test(txt)) service = "ogrzewanie_serwis";

  const urgency = /(zalew|wyciek|iskr|dymi|gaz)/.test(txt) ? "now" :
                  /(nie dzia[łl]a|awaria|pilne)/.test(txt) ? "today" : "normal";

  const orderTitle = problemText.length > 80 ? problemText.slice(0,80) + "..." : problemText;

  return {
    category: service,
    detected_service_slug: service,
    problem_summary: problemText,
    diy_steps: [
      "Sprawdź oczywiste przyczyny (zasilanie, zawory, wyłączniki).",
      "Zrób zdjęcie/film objawu — ułatwi wycenę.",
      "Jeśli to wyciek / zwarcie — odetnij wodę/prąd i wezwij specjalistę.",
    ],
    risk_level: urgency === "now" ? "high" : urgency === "today" ? "medium" : "low",
    recommended_urgency: urgency,
    order_payload: {
      service: service,
      title: orderTitle || "Zgłoszenie problemu",
      description: problemText,
      location: null, // wypełnisz na froncie (geolokacja / adres)
      budget_hint: { min: null, max: null, currency: "PLN" },
    },
    provider_match_tags: [service],
    followup_questions: ["Czy możesz dodać zdjęcie/film?", "Czy problem pojawił się nagle czy narastał?"],
  };
}

async function conciergeLLMExtract(problemText, userContext = {}) {
  // Użyj LLM Service (Claude 3.5 z fallbackiem do Ollama)
  try {
    const llmService = require('../services/llm_service');
    const result = await llmService.analyzeProblem({ 
      description: problemText, 
      lang: 'pl' 
    });
    
    // Mapuj wynik LLM Service na format Concierge
    return {
      category: result.serviceCandidate?.code || "inne",
      detected_service_slug: result.serviceCandidate?.code || "inne",
      problem_summary: problemText,
      diy_steps: result.diySteps || [],
      risk_level: result.dangerFlags?.length > 0 ? "high" : "low",
      recommended_urgency: result.urgency || "normal",
      order_payload: {
        service: result.serviceCandidate?.code || "inne",
        title: problemText.length > 80 ? problemText.slice(0,80) + "..." : problemText,
        description: problemText,
        location: null,
        budget_hint: result.estimatedCost || { min: null, max: null, currency: "PLN" },
      },
      provider_match_tags: [result.serviceCandidate?.code || "inne"],
      followup_questions: ["Czy możesz dodać zdjęcie problemu?", "Czy problem pojawił się nagle?"],
    };
  } catch (error) {
    console.error('LLM Service error, using fallback:', error.message);
    return heuristicExtract(problemText);
  }
}

module.exports = { conciergeLLMExtract };









