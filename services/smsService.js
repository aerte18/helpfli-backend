?const axios = require('axios');
const NotificationLog = require('../models/NotificationLog');

/**
 * Serwis do wysyłania SMS
 * Obsługuje SMSAPI.pl (domyślnie) i Twilio (opcjonalnie)
 */
class SMSService {
  constructor() {
    this.provider = process.env.SMS_PROVIDER || 'smsapi'; // 'smsapi' lub 'twilio'
    this.smsapiToken = process.env.SMSAPI_TOKEN;
    this.smsapiSender = process.env.SMSAPI_SENDER || 'Helpfli';
    this.twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    this.twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    this.twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  }

  /**
   * Wysyła SMS
   * @param {string} phoneNumber - Numer telefonu (format: +48123456789 lub 48123456789)
   * @param {string} message - Treść wiadomości
   * @param {Object} options - Opcje (userId, type, metadata)
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendSMS(phoneNumber, message, options = {}) {
    const { userId, type = 'other', metadata = {} } = options;

    // Normalizuj numer telefonu
    let normalizedPhone = phoneNumber.replace(/\s+/g, '').replace(/-/g, '');
    if (!normalizedPhone.startsWith('+')) {
      if (normalizedPhone.startsWith('00')) {
        normalizedPhone = '+' + normalizedPhone.substring(2);
      } else if (normalizedPhone.startsWith('0')) {
        normalizedPhone = '+48' + normalizedPhone.substring(1);
      } else {
        normalizedPhone = '+48' + normalizedPhone;
      }
    }

    // Utwórz log przed wysłaniem
    const log = new NotificationLog({
      user: userId,
      type,
      channel: 'sms',
      status: 'pending',
      message,
      recipient: normalizedPhone,
      metadata
    });

    try {
      let result;

      if (this.provider === 'smsapi') {
        result = await this.sendViaSMSAPI(normalizedPhone, message);
      } else if (this.provider === 'twilio') {
        result = await this.sendViaTwilio(normalizedPhone, message);
      } else {
        throw new Error(`Nieznany dostawca SMS: ${this.provider}`);
      }

      // Zaktualizuj log
      log.status = 'sent';
      log.sentAt = new Date();
      if (result.messageId) {
        log.metadata.messageId = result.messageId;
      }
      await log.save();

      return {
        success: true,
        messageId: result.messageId,
        logId: log._id
      };
    } catch (error) {
      console.error('SMS sending error:', error);
      
      // Zaktualizuj log z błędem
      log.status = 'failed';
      log.error = error.message;
      log.sentAt = new Date();
      await log.save();

      return {
        success: false,
        error: error.message,
        logId: log._id
      };
    }
  }

  /**
   * Wysyła SMS przez SMSAPI.pl
   */
  async sendViaSMSAPI(phoneNumber, message) {
    if (!this.smsapiToken) {
      throw new Error('SMSAPI_TOKEN nie jest skonfigurowany');
    }

    try {
      const response = await axios.post(
        'https://api.smsapi.pl/sms.do',
        new URLSearchParams({
          to: phoneNumber,
          message: message,
          from: this.smsapiSender,
          format: 'json'
        }),
        {
          headers: {
            'Authorization': `Bearer ${this.smsapiToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      if (response.data.error) {
        throw new Error(`SMSAPI error: ${response.data.error} (${response.data.message || ''})`);
      }

      return {
        messageId: response.data.list?.[0]?.id || response.data.id || null
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`SMSAPI HTTP error: ${error.response.status} - ${error.response.data?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Wysyła SMS przez Twilio
   */
  async sendViaTwilio(phoneNumber, message) {
    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.twilioPhoneNumber) {
      throw new Error('Twilio credentials nie są skonfigurowane');
    }

    try {
      const twilio = require('twilio');
      const client = twilio(this.twilioAccountSid, this.twilioAuthToken);

      const result = await client.messages.create({
        body: message,
        from: this.twilioPhoneNumber,
        to: phoneNumber
      });

      return {
        messageId: result.sid
      };
    } catch (error) {
      throw new Error(`Twilio error: ${error.message}`);
    }
  }

  /**
   * Sprawdza status SMS (jeśli dostawca to obsługuje)
   */
  async checkStatus(messageId) {
    // TODO: Implementacja sprawdzania statusu
    return { status: 'unknown' };
  }
}

module.exports = new SMSService();

