// Helper do wywoływania webhooków przy różnych wydarzeniach
const webhookService = require('../services/webhookService');

/**
 * Wywołuje webhooki dla danego wydarzenia
 * Użyj tego w miejscach, gdzie występują wydarzenia (np. przy tworzeniu zlecenia)
 */
async function triggerWebhook(event, data) {
  try {
    // Wywołaj webhooki asynchronicznie (nie blokuj głównego flow)
    setImmediate(async () => {
      await webhookService.sendWebhook(event, data);
    });
  } catch (error) {
    console.error(`WEBHOOK_TRIGGER_ERROR [${event}]:`, error);
    // Nie rzucamy błędu, żeby nie przerwać głównego flow
  }
}

module.exports = { triggerWebhook };













