/**
 * AI Router — hybrydowe routowanie Gemini (tani) ↔ Claude (smart)
 *
 * AI_ROUTER_MODE=hybrid|claude|gemini
 * AI_CHEAP_MODEL=gemini-2.0-flash
 * AI_SMART_MODEL=claude-haiku-4-5-20251001
 */

const { callGeminiJSON, hasGeminiKey } = require('../ai/providers/geminiProvider');
const { callClaudeJSON, hasClaudeKey } = require('../ai/providers/claudeProvider');

const ORDER_TOOL_PATTERN = /zlecen|zamów|zamow|anuluj|przedłuż|przedluz|moje\s+zlec|utwórz|utworz|stwórz|stworz|wystaw|załóż|zaloz|lista\s+zlec|status\s+zlec|create\s*order|my\s+orders|chc[eę]\s+zlecen/i;
const DANGER_PATTERN = /gaz\s*wyciek|wyciek\s*gazu|zapach\s*gazu|porażen|porazen|iskr|dym\s*z\s*gnia|pożar|pozar|zalanie|zalało|zalało|cieknący\s*gaz/i;

function getRoutingMode() {
  const mode = (
    process.env.AI_ROUTER_MODE ||
    process.env.AI_MODE ||
    process.env.LLM_ROUTING_MODE ||
    ''
  ).toLowerCase().trim();

  if (mode === 'claude' || mode === 'claude_only') return 'claude';
  if (mode === 'gemini' || mode === 'gemini_only') return 'gemini';
  if (mode === 'hybrid' || mode === 'auto') return 'hybrid';

  if (hasGeminiKey() && hasClaudeKey()) return 'hybrid';
  if (hasGeminiKey()) return 'gemini';
  return 'claude';
}

function getLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const last = messages.filter((m) => m && m.role === 'user').pop();
  return (last?.content || last?.text || '').trim();
}

function shouldEnableConciergeTools(messages, userContext = {}) {
  if (!Array.isArray(messages)) return false;
  const text = getLastUserText(messages);
  if (ORDER_TOOL_PATTERN.test(text)) return true;
  if ((userContext.imageUrls || []).length > 0) return true;
  if (messages.length > 10) return true;
  if (DANGER_PATTERN.test(text)) return true;
  return false;
}

function shouldUseSmartModel({ messages, context = {}, agentType = 'concierge', enableTools = false }) {
  if (!Array.isArray(messages)) return agentType === 'diagnostic';
  if (enableTools && shouldEnableConciergeTools(messages, context)) return true;

  const text = getLastUserText(messages);
  if (!text) return false;

  if (DANGER_PATTERN.test(text)) return true;
  if (text.length > 500) return true;
  if ((context.imageUrls || []).length > 0) return true;
  if (messages.length > 12) return true;

  if (agentType === 'diagnostic') return true;
  if (agentType === 'pricing' && /wycen|koszt|cena|ile\s+koszt/i.test(text)) return true;

  return false;
}

function isGoodEnough(parsed, agentType = 'concierge') {
  if (!parsed || typeof parsed !== 'object') return false;

  if (agentType === 'concierge') {
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (reply.length < 40) return false;

    const low = reply.toLowerCase();
    if (/nie wiem|nie mogę pomóc|nie moge pomoc|nie jestem pewien|jako model językowy/i.test(low)) {
      return false;
    }
    if (parsed.confidence != null && Number(parsed.confidence) < 0.45) return false;
    if (!parsed.detectedService && !parsed.intent) return false;
    return true;
  }

  return Object.keys(parsed).length > 0;
}

function attachMeta(parsed, meta) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  parsed.__llmMeta = meta;
  return parsed;
}

/**
 * Routuje wywołanie JSON do taniego lub smart modelu.
 * @returns {Promise<{ parsed: Object, meta: Object }>}
 */
async function routeJSON({ systemPrompt, messages, agentType = 'concierge', context = {} }) {
  const mode = getRoutingMode();
  const smart = shouldUseSmartModel({ messages, context, agentType, enableTools: false });

  const logRoute = (provider, tier, reason, escalated = false) => {
    console.log(`[AI Router] mode=${mode} provider=${provider} tier=${tier} agent=${agentType} reason=${reason}${escalated ? ' escalated=true' : ''}`);
    return { provider, tier, mode, reason, escalated };
  };

  if (mode === 'claude' || smart) {
    const parsed = await callClaudeJSON(systemPrompt, messages);
    return {
      parsed: attachMeta(parsed, logRoute('claude', 'smart', smart ? 'complex_query' : 'claude_only')),
      meta: parsed.__llmMeta
    };
  }

  if (mode === 'gemini') {
    try {
      const parsed = await callGeminiJSON(systemPrompt, messages);
      if (isGoodEnough(parsed, agentType)) {
        return {
          parsed: attachMeta(parsed, logRoute('gemini', 'cheap', 'gemini_only')),
          meta: parsed.__llmMeta
        };
      }
      if (hasClaudeKey()) {
        const escalated = await callClaudeJSON(systemPrompt, messages);
        return {
          parsed: attachMeta(escalated, logRoute('claude', 'smart', 'quality_escalation', true)),
          meta: escalated.__llmMeta
        };
      }
      return {
        parsed: attachMeta(parsed, logRoute('gemini', 'cheap', 'gemini_weak_no_claude')),
        meta: parsed.__llmMeta
      };
    } catch (err) {
      if (!hasClaudeKey()) throw err;
      const parsed = await callClaudeJSON(systemPrompt, messages);
      return {
        parsed: attachMeta(parsed, logRoute('claude', 'smart', 'gemini_error_fallback', true)),
        meta: parsed.__llmMeta
      };
    }
  }

  // hybrid: gemini first, claude on weak answer or error
  if (!hasGeminiKey()) {
    const parsed = await callClaudeJSON(systemPrompt, messages);
    return {
      parsed: attachMeta(parsed, logRoute('claude', 'smart', 'no_gemini_key')),
      meta: parsed.__llmMeta
    };
  }

  try {
    const cheap = await callGeminiJSON(systemPrompt, messages);
    if (isGoodEnough(cheap, agentType)) {
      return {
        parsed: attachMeta(cheap, logRoute('gemini', 'cheap', 'hybrid_ok')),
        meta: cheap.__llmMeta
      };
    }

    if (!hasClaudeKey()) {
      return {
        parsed: attachMeta(cheap, logRoute('gemini', 'cheap', 'hybrid_weak_no_claude')),
        meta: cheap.__llmMeta
      };
    }

    const smartParsed = await callClaudeJSON(systemPrompt, messages);
    return {
      parsed: attachMeta(smartParsed, logRoute('claude', 'smart', 'hybrid_escalation', true)),
      meta: smartParsed.__llmMeta
    };
  } catch (geminiErr) {
    console.warn('[AI Router] Gemini failed:', geminiErr.message);
    if (!hasClaudeKey()) throw geminiErr;
    const parsed = await callClaudeJSON(systemPrompt, messages);
    return {
      parsed: attachMeta(parsed, logRoute('claude', 'smart', 'gemini_error', true)),
      meta: parsed.__llmMeta
    };
  }
}

module.exports = {
  getRoutingMode,
  shouldUseSmartModel,
  shouldEnableConciergeTools,
  isGoodEnough,
  routeJSON,
  attachMeta
};
