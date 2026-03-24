// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args)); // tymczasowo wyłączone

async function sendPushToUser(userId, { title, message, url }) {
  // Sprawdź czy klucze OneSignal są skonfigurowane
  if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_REST_API_KEY || 
      process.env.ONESIGNAL_APP_ID === "demo-app-id") {
    console.log('OneSignal not configured, skipping push notification');
    return;
  }
  
  try {
    const body = {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_external_user_ids: [String(userId)],
      headings: { en: title, pl: title },
      contents: { en: message, pl: message },
      url: url || process.env.FRONTEND_URL,
    };
    
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      console.error('OneSignal API error:', await response.text());
    } else {
      console.log('Push notification sent successfully');
    }
  } catch (err) {
    console.error('Push notification error:', err);
  }
}

module.exports = { sendPushToUser };
