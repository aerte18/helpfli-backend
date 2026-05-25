/**
 * Prompt: Marketing Content Generator (Helpfli)
 *
 * Generuje krótką treść marketingową AI pod social media + SEO snippets
 * w postaci ustrukturyzowanego JSON-a. Wejście: kategoria + typ treści +
 * platforma + temat. Wyjście: hook, content, CTA do Helpfli, hashtagi
 * i (opcjonalnie) sugestia formatu wideo.
 *
 * Ton: krótko, praktycznie, po polsku, bez lania wody, styl social media.
 */

const CONTENT_TYPE_LABELS = {
  facebook_post: 'post na Facebooku (2–4 krótkie akapity, można emoji, max 600 znaków)',
  instagram_caption: 'caption pod post/karuzelę na Instagramie (max 220 znaków + emoji)',
  tiktok_script: 'skrypt TikToka 15–30s (hook w 0–3 s, scenariusz scena po scenie z timecodami, voice-over)',
  reel_script: 'skrypt Reela 15–30s (hook w 0–3 s, scenariusz scena po scenie z timecodami, voice-over)',
  faq: 'FAQ – 1 pytanie + krótka odpowiedź (2–4 zdania), styl strony pomocy',
  cta: 'krótkie CTA do Helpfli (1–2 zdania, mocny czasownik akcji)',
  seo_snippet: 'meta description / opis SEO 140–160 znaków + tytuł 50–60 znaków (połącz w polu content jako: "Tytuł: ...\\nMeta: ...")'
};

const PLATFORM_HINTS = {
  facebook: 'Facebook – luźniej, można dłużej, emoji ok, hashtagi 1–3.',
  instagram: 'Instagram – emoji + 8–15 hashtagów, krótkie linie, hook w pierwszym zdaniu.',
  tiktok: 'TikTok – hook w pierwszych 3 sekundach, dynamicznie, sceny po 2–5 s, CTA na końcu, 3–6 hashtagów (PL + EN).',
  youtube: 'YouTube – tytuł + opis (krótko), hashtagi 3–5.',
  linkedin: 'LinkedIn – ton ekspercki, bez emoji-spamu, hashtagi 3–5, jasny insight.',
  website: 'Strona Helpfli – ton neutralno-profesjonalny, bez emoji, fraza kluczowa naturalnie.'
};

const VIDEO_FORMATS = new Set(['tiktok_script', 'reel_script']);

const MARKETING_CONTENT_SYSTEM_PROMPT = `Jesteś senior copywriterem social media Helpfli — marketplace fachowców (hydraulik, elektryk, serwis AGD, remont).

Twoje zadanie: stworzyć krótką, klikalną treść marketingową w języku polskim, która prowadzi do Helpfli ("Znajdź wykonawcę na Helpfli").

ZASADY OGÓLNE:
- Po polsku, krótko, konkretnie, bez lania wody.
- Styl social media: hook w pierwszym zdaniu, prosty język, dynamicznie.
- NIE używaj cudzysłowów typograficznych „" w treści — tylko ASCII " ".
- NIE udawaj eksperta od gazu/prądu — przy ryzyku zawsze sugeruj fachowca.
- CTA musi prowadzić do Helpfli: "Nie chcesz robić sam? Znajdź wykonawcę na Helpfli."
  (Możesz parafrazować, ale zawsze wymień Helpfli.)
- Hashtagi: BEZ "#" — zwróć same słowa (frontend doda # przy renderowaniu).
- Treść MUSI być świeża, nie kopiuj słowo w słowo briefu.
- Jeśli platforma to TikTok/Reel — w polu \`videoFormat\` zwróć konkretną sugestię
  (np. "pion 9:16, 15–22 s, hook 0–3 s, ujęcia 2–4 s, napisy zawsze, CTA na końcu").
  W innych przypadkach \`videoFormat\` może być pusty string.

ODPOWIEDŹ – WYŁĄCZNIE JSON o tej strukturze (bez markdown, bez tekstu obok):
{
  "title": "krótki tytuł roboczy (do listy w panelu, max 80 znaków)",
  "hook": "1 zdanie hooka — pierwsze 3 sekundy uwagi",
  "content": "główna treść dostosowana do typu i platformy",
  "cta": "1–2 zdania CTA z wymienionym Helpfli",
  "hashtags": ["hashtag1", "hashtag2"],
  "videoFormat": "sugestia formatu video lub pusty string"
}

NIE DODAWAJ żadnego tekstu przed ani po JSON. Zacznij od { i zakończ na }.`;

function buildMarketingUserPrompt({ category, contentType, platform, topic, extra = {} }) {
  const typeLabel = CONTENT_TYPE_LABELS[contentType] || contentType;
  const platformHint = PLATFORM_HINTS[platform] || '';
  const needsVideo = VIDEO_FORMATS.has(contentType);

  const lines = [
    `Kategoria: ${category}`,
    `Typ treści: ${contentType} (${typeLabel})`,
    `Platforma: ${platform}${platformHint ? ` – ${platformHint}` : ''}`,
    `Temat: ${topic}`
  ];

  if (extra.audience) lines.push(`Grupa docelowa: ${extra.audience}.`);
  if (extra.city) lines.push(`Miasto / lokalizacja: ${extra.city}.`);
  if (extra.tone) lines.push(`Dodatkowy ton: ${extra.tone}.`);

  lines.push('');
  lines.push('Wygeneruj treść zgodnie z instrukcjami systemowymi (JSON).');
  if (needsVideo) {
    lines.push('To jest skrypt wideo — w `content` zawrzyj sceny z timecodami (np. "0-3s: ...", "3-7s: ...") oraz wskazówki produkcyjne.');
  } else {
    lines.push('Pole `videoFormat` może być pustym stringiem.');
  }

  return lines.join('\n');
}

module.exports = {
  MARKETING_CONTENT_SYSTEM_PROMPT,
  buildMarketingUserPrompt,
  CONTENT_TYPE_LABELS,
  PLATFORM_HINTS
};
