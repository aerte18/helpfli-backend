/**
 * Synchronizacja odpowiedzi Concierge z draftem zlecenia (CTA, braki, nextStep)
 */

const WANTS_ORDER_PATTERN = /wystaw|utwórz|utworz|stwórz|stworz|załóż|zaloz|chc[eę]\s+zlecen|potrzebuj[eę]\s+(fachowca|wykonawcy|hydraulika|elektryka)|znajd[zź]\s+wykonawc/i;

function wantsToCreateOrder(text = '') {
  return WANTS_ORDER_PATTERN.test(String(text));
}

function enrichConciergeWithOrderDraft(concierge = {}, draft = {}, { lastUserText = '' } = {}) {
  if (!draft || !draft.ok) return concierge;

  const userWantsOrder = wantsToCreateOrder(lastUserText);

  if (draft.canCreate) {
    if (
      userWantsOrder ||
      ['ask_more', 'suggest_providers', 'suggest_diy', 'show_pricing', 'diagnose'].includes(concierge.nextStep)
    ) {
      concierge.nextStep = 'create_order';
    }
    if (!/zlecen|potwierdz|utwórz|utworz|wystaw/i.test(concierge.reply || '')) {
      concierge.reply = `${(concierge.reply || '').trim()}\n\n**Mam komplet danych** — możesz potwierdzić utworzenie zlecenia w panelu poniżej.`.trim();
    }
    concierge.missing = [];
  } else if (draft.missing?.length) {
    concierge.nextStep = 'ask_more';
    concierge.missing = draft.missing;
    if (draft.nextQuestion) {
      concierge.questions = [draft.nextQuestion];
      if (!String(concierge.reply || '').includes('?')) {
        concierge.reply = `${(concierge.reply || '').trim()}\n\n${draft.nextQuestion}`.trim();
      }
    }
    if (userWantsOrder && draft.missing.length) {
      const missingList = draft.missing.join(', ');
      if (!concierge.reply?.toLowerCase().includes(missingList.toLowerCase().slice(0, 8))) {
        concierge.reply = `${(concierge.reply || '').trim()}\n\nŻeby wystawić zlecenie, potrzebuję jeszcze: **${missingList}**.`.trim();
      }
    }
  } else if ((draft.completion?.percent || 0) >= 55 && userWantsOrder) {
    concierge.nextStep = 'ask_more';
    if (draft.nextQuestion) {
      concierge.questions = [draft.nextQuestion];
    }
  }

  return concierge;
}

function normalizeAttachmentsFromUrls(urls = []) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  return urls
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => {
      const trimmed = url.trim();
      const filename = trimmed.split('/').pop()?.split('?')[0] || 'zdjecie.jpg';
      const lower = filename.toLowerCase();
      let mimeType = 'application/octet-stream';
      if (/\.(jpe?g)$/i.test(lower)) mimeType = 'image/jpeg';
      else if (/\.png$/i.test(lower)) mimeType = 'image/png';
      else if (/\.webp$/i.test(lower)) mimeType = 'image/webp';
      else if (/\.gif$/i.test(lower)) mimeType = 'image/gif';
      else if (/\.(heic|heif)$/i.test(lower)) mimeType = 'image/heic';
      return { url: trimmed, mimeType, filename, size: 0 };
    })
    .filter((att) => {
      if (seen.has(att.url)) return false;
      seen.add(att.url);
      return true;
    });
}

function mergeAttachmentLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      const url = typeof item === 'string' ? item : item?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(typeof item === 'string' ? normalizeAttachmentsFromUrls([item])[0] : item);
    }
  }
  return out;
}

module.exports = {
  wantsToCreateOrder,
  enrichConciergeWithOrderDraft,
  normalizeAttachmentsFromUrls,
  mergeAttachmentLists
};
