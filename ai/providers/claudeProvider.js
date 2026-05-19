/**
 * Anthropic Claude API (JSON) — smart tier
 */

const { safeParseJSON, toAnthropicMessages } = require('../utils/jsonParse');

const JSON_SUFFIX = `

KRYTYCZNE: Odpowiedz WYŁĄCZNIE w formacie JSON. Nie dodawaj żadnego tekstu przed ani po JSON.
JSON powinien być poprawny, parsowalny, bez dodatkowych znaków, bez markdown code blocks.
Zacznij odpowiedź bezpośrednio od { i zakończ na }.`;

function getSmartModel() {
  return process.env.AI_SMART_MODEL || process.env.CLAUDE_DEFAULT || 'claude-haiku-4-5-20251001';
}

function hasClaudeKey() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  return key.trim().length > 20 && key.startsWith('sk-ant-');
}

/**
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {string} [model]
 * @returns {Promise<Object>}
 */
async function callClaudeJSON(systemPrompt, messages, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not found');
  }

  const client = new Anthropic({ apiKey });
  const fullMessages = toAnthropicMessages(messages);
  const enhancedSystemPrompt = `${systemPrompt}${JSON_SUFFIX}`;

  const response = await client.messages.create({
    model: model || getSmartModel(),
    max_tokens: 2000,
    temperature: 0.4,
    system: enhancedSystemPrompt,
    messages: fullMessages
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  const parsed = safeParseJSON(content.text.trim());
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Claude did not return valid JSON');
  }

  return parsed;
}

module.exports = {
  callClaudeJSON,
  getSmartModel,
  hasClaudeKey
};
