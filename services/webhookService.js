?// Serwis do wysyłania webhooków do partnerów
const axios = require('axios');
const crypto = require('crypto');
const Webhook = require('../models/Webhook');

class WebhookService {
  /**
   * Wysyła webhook do wszystkich aktywnych webhooków dla danego wydarzenia
   * @param {String} event - Typ wydarzenia (np. 'order.created')
   * @param {Object} data - Dane wydarzenia
   */
  async sendWebhook(event, data) {
    try {
      // Znajdź wszystkie aktywne webhooki dla tego wydarzenia
      const webhooks = await Webhook.find({
        events: event,
        isActive: true
      }).populate('partner');

      if (webhooks.length === 0) {
        return { sent: 0, failed: 0 };
      }

      const results = await Promise.allSettled(
        webhooks.map(webhook => this.sendToWebhook(webhook, event, data))
      );

      const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

      return { sent, failed, total: webhooks.length };
    } catch (error) {
      console.error('WEBHOOK_SERVICE_SEND_ERROR:', error);
      return { sent: 0, failed: 0, error: error.message };
    }
  }

  /**
   * Wysyła webhook do konkretnego URL
   * @param {Object} webhook - Obiekt webhooka z bazy
   * @param {String} event - Typ wydarzenia
   * @param {Object} data - Dane wydarzenia
   */
  async sendToWebhook(webhook, event, data) {
    try {
      const payload = {
        event,
        data,
        timestamp: new Date().toISOString(),
        id: crypto.randomUUID()
      };

      // Utwórz podpis HMAC
      const signature = this.createSignature(webhook.secret, JSON.stringify(payload));

      // Wyślij webhook
      const response = await axios.post(webhook.url, payload, {
        headers: {
          'X-Helpfli-Event': event,
          'X-Helpfli-Signature': signature,
          'X-Helpfli-Webhook-Id': payload.id,
          'Content-Type': 'application/json'
        },
        timeout: webhook.config.timeout
      });

      // Aktualizuj statystyki (sukces)
      webhook.stats.totalSent += 1;
      webhook.stats.successful += 1;
      webhook.stats.lastSentAt = new Date();
      webhook.stats.lastSuccessAt = new Date();
      await webhook.save();

      return { success: true, status: response.status };
    } catch (error) {
      // Aktualizuj statystyki (błąd)
      webhook.stats.totalSent += 1;
      webhook.stats.failed += 1;
      webhook.stats.lastSentAt = new Date();
      webhook.stats.lastFailureAt = new Date();
      webhook.stats.lastFailureReason = error.message || 'Unknown error';
      await webhook.save();

      console.error(`WEBHOOK_SEND_ERROR [${webhook.url}]:`, error.message);
      
      // Retry logic (uproszczone - w produkcji można użyć queue)
      if (webhook.config.retries > 0) {
        // Można dodać retry z opóźnieniem
        // await this.retryWebhook(webhook, event, data);
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Tworzy podpis HMAC dla webhooka
   * @param {String} secret - Secret webhooka
   * @param {String} payload - JSON payload
   */
  createSignature(secret, payload) {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  /**
   * Weryfikuje podpis webhooka
   * @param {String} signature - Podpis z nagłówka
   * @param {String} secret - Secret webhooka
   * @param {String} payload - JSON payload
   */
  verifySignature(signature, secret, payload) {
    const expectedSignature = this.createSignature(secret, payload);
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}

module.exports = new WebhookService();













