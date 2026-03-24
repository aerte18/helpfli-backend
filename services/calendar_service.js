// Integracja z kalendarzami (Google Calendar, Outlook)
const axios = require('axios');

class CalendarService {
  constructor() {
    this.googleEnabled = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
    this.outlookEnabled = !!process.env.OUTLOOK_CLIENT_ID && !!process.env.OUTLOOK_CLIENT_SECRET;
  }

  /**
   * Generuje URL autoryzacji Google Calendar
   */
  getGoogleAuthUrl(redirectUri, state) {
    if (!this.googleEnabled) {
      throw new Error('Google Calendar integration is not configured');
    }

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar',
      access_type: 'offline',
      prompt: 'consent',
      state: state || 'default'
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Wymienia kod autoryzacji na token Google
   */
  async exchangeGoogleCode(code, redirectUri) {
    if (!this.googleEnabled) {
      throw new Error('Google Calendar integration is not configured');
    }

    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        tokenType: response.data.token_type
      };
    } catch (error) {
      console.error('Google token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange Google authorization code');
    }
  }

  /**
   * Odświeża token Google
   */
  async refreshGoogleToken(refreshToken) {
    if (!this.googleEnabled) {
      throw new Error('Google Calendar integration is not configured');
    }

    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      console.error('Google token refresh error:', error.response?.data || error.message);
      throw new Error('Failed to refresh Google token');
    }
  }

  /**
   * Tworzy wydarzenie w Google Calendar
   */
  async createGoogleEvent(accessToken, event) {
    if (!this.googleEnabled) {
      throw new Error('Google Calendar integration is not configured');
    }

    try {
      const response = await axios.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          summary: event.title,
          description: event.description || '',
          start: {
            dateTime: event.startTime,
            timeZone: event.timeZone || 'Europe/Warsaw'
          },
          end: {
            dateTime: event.endTime,
            timeZone: event.timeZone || 'Europe/Warsaw'
          },
          location: event.location || '',
          attendees: event.attendees?.map(email => ({ email })) || []
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        htmlLink: response.data.htmlLink,
        start: response.data.start,
        end: response.data.end
      };
    } catch (error) {
      console.error('Google Calendar create event error:', error.response?.data || error.message);
      throw new Error('Failed to create Google Calendar event');
    }
  }

  /**
   * Generuje URL autoryzacji Outlook
   */
  getOutlookAuthUrl(redirectUri, state) {
    if (!this.outlookEnabled) {
      throw new Error('Outlook integration is not configured');
    }

    const params = new URLSearchParams({
      client_id: process.env.OUTLOOK_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite',
      response_mode: 'query',
      state: state || 'default'
    });

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Wymienia kod autoryzacji na token Outlook
   */
  async exchangeOutlookCode(code, redirectUri) {
    if (!this.outlookEnabled) {
      throw new Error('Outlook integration is not configured');
    }

    try {
      const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        tokenType: response.data.token_type
      };
    } catch (error) {
      console.error('Outlook token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange Outlook authorization code');
    }
  }

  /**
   * Odświeża token Outlook
   */
  async refreshOutlookToken(refreshToken) {
    if (!this.outlookEnabled) {
      throw new Error('Outlook integration is not configured');
    }

    try {
      const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      console.error('Outlook token refresh error:', error.response?.data || error.message);
      throw new Error('Failed to refresh Outlook token');
    }
  }

  /**
   * Tworzy wydarzenie w Outlook Calendar
   */
  async createOutlookEvent(accessToken, event) {
    if (!this.outlookEnabled) {
      throw new Error('Outlook integration is not configured');
    }

    try {
      const response = await axios.post(
        'https://graph.microsoft.com/v1.0/me/calendar/events',
        {
          subject: event.title,
          body: {
            contentType: 'HTML',
            content: event.description || ''
          },
          start: {
            dateTime: event.startTime,
            timeZone: event.timeZone || 'Europe/Warsaw'
          },
          end: {
            dateTime: event.endTime,
            timeZone: event.timeZone || 'Europe/Warsaw'
          },
          location: {
            displayName: event.location || ''
          },
          attendees: event.attendees?.map(email => ({
            emailAddress: { address: email },
            type: 'required'
          })) || []
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        id: response.data.id,
        webLink: response.data.webLink,
        start: response.data.start,
        end: response.data.end
      };
    } catch (error) {
      console.error('Outlook Calendar create event error:', error.response?.data || error.message);
      throw new Error('Failed to create Outlook Calendar event');
    }
  }

  /**
   * Sprawdza status integracji
   */
  getStatus() {
    return {
      google: {
        enabled: this.googleEnabled,
        configured: this.googleEnabled
      },
      outlook: {
        enabled: this.outlookEnabled,
        configured: this.outlookEnabled
      }
    };
  }
}

module.exports = new CalendarService();













