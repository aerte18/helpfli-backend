/**
 * Agent Post-Order
 * Po zakończeniu: ocena + retencja + upsell
 */

const { POST_ORDER_SYSTEM } = require('../prompts/postOrderPrompt');
const { callAgentLLM, safeParseJSON } = require('../utils/llmAdapter');

/**
 * Główna funkcja agenta Post-Order
 * @param {Object} params
 * @param {string} params.service - Kategoria usługi
 * @param {string} params.outcome - Wynik (completed, cancelled, etc.)
 * @param {boolean} params.paidInApp - Czy zapłacono w aplikacji
 * @param {number} params.rating - Ocena (opcjonalnie)
 * @returns {Promise<Object>} Response agenta
 */
async function runPostOrderAgent({ service, outcome = 'completed', paidInApp = false, rating = null }) {
  try {
    // Określ czy zlecenie zakończone sukcesem
    const isCompleted = outcome === 'completed' || outcome === 'finished';
    const hasRating = typeof rating === 'number' && rating > 0;
    
    // Przygotuj wiadomość do klienta
    let messageToClient = '';
    if (isCompleted && hasRating && rating >= 4) {
      messageToClient = 'Dziękujemy za korzystanie z Helpfli! Cieszę się, że wszystko się udało.';
    } else if (isCompleted && hasRating && rating < 4) {
      messageToClient = 'Dziękujemy za feedback. Postaramy się poprawić jakość usług.';
    } else if (isCompleted) {
      messageToClient = 'Zlecenie zakończone! Czy wszystko jest w porządku?';
    } else {
      messageToClient = 'Zlecenie zostało anulowane. Czy mogę pomóc w czymś innym?';
    }
    
    // Rating prompt
    const ratingPrompt = {
      ask: !hasRating && isCompleted,
      text: hasRating 
        ? 'Dziękujemy za ocenę!'
        : 'Oceń wykonawcę - pomoże innym użytkownikom w wyborze.'
    };
    
    // Follow-up - sugeruj powiązane usługi
    const followUp = getFollowUpSuggestion(service, isCompleted);
    
    return {
      ok: true,
      agent: 'post_order',
      messageToClient: messageToClient.slice(0, 200),
      ratingPrompt,
      followUp
    };
    
  } catch (error) {
    console.error('Post-Order Agent error:', error);
    
    return {
      ok: false,
      agent: 'post_order',
      messageToClient: 'Dziękujemy za korzystanie z Helpfli!',
      ratingPrompt: {
        ask: false,
        text: ''
      },
      followUp: {
        suggested: false,
        service: null,
        reason: null
      }
    };
  }
}

/**
 * Sugestia follow-up usługi na podstawie kategorii
 */
function getFollowUpSuggestion(service, isCompleted) {
  if (!isCompleted) {
    return { suggested: false, service: null, reason: null };
  }
  
  const serviceLower = (service || '').toLowerCase();
  
  // Hydraulika → konserwacja co 6 miesięcy
  if (serviceLower.includes('hydraulik') || serviceLower.includes('woda')) {
    return {
      suggested: true,
      service: 'hydraulik_konserwacja',
      reason: 'Zalecamy kontrolę instalacji wodnej co 6 miesięcy - zapobiegaj problemom'
    };
  }
  
  // Elektryka → kontrola instalacji
  if (serviceLower.includes('elektryk') || serviceLower.includes('prąd')) {
    return {
      suggested: true,
      service: 'elektryk_kontrola',
      reason: 'Zalecamy kontrolę instalacji elektrycznej raz w roku - bezpieczeństwo'
    };
  }
  
  // Remont → kolejny etap remontu
  if (serviceLower.includes('remont')) {
    return {
      suggested: true,
      service: 'remont',
      reason: 'Masz więcej do zrobienia? Kontynuuj remont z naszymi wykonawcami'
    };
  }
  
  return { suggested: false, service: null, reason: null };
}

module.exports = {
  runPostOrderAgent
};

