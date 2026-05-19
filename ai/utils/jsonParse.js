/**
 * Parsowanie JSON z odpowiedzi LLM + normalizacja wiadomości dla Claude
 */

function safeParseJSON(text) {
  if (!text || typeof text !== 'string') return null;

  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e2) {
        // ignore
      }
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch (e3) {
        // ignore
      }
    }
  }

  return null;
}

function toAnthropicMessages(messages = []) {
  const normalized = messages
    .filter((m) => m && m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m === 'string' ? m : (m.content || m.text || '')
    }))
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);

  while (normalized[0]?.role === 'assistant') {
    normalized.shift();
  }

  return normalized.reduce((acc, msg) => {
    const last = acc[acc.length - 1];
    if (last && last.role === msg.role) {
      last.content = `${last.content}\n\n${msg.content}`;
      return acc;
    }
    acc.push({ ...msg });
    return acc;
  }, []);
}

module.exports = {
  safeParseJSON,
  toAnthropicMessages
};
