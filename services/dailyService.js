// Service do integracji z Daily.co API
// Wymaga: DAILY_API_KEY w .env

const axios = require('axios');

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API_URL = 'https://api.daily.co/v1';

if (!DAILY_API_KEY) {
  console.warn('⚠️ DAILY_API_KEY nie jest ustawiony - wideo-wizyty nie będą działać');
}

/**
 * Tworzy nowy pokój w Daily.co
 * @param {Object} options - Opcje pokoju
 * @returns {Promise<Object>} - Dane pokoju
 */
async function createRoom(options = {}) {
  if (!DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY nie jest skonfigurowany');
  }

  const {
    name = null, // Jeśli null, Daily.co wygeneruje unikalną nazwę
    privacy = 'private', // 'private' | 'public'
    properties = {
      enable_screenshare: true,
      enable_chat: true,
      enable_knocking: false,
      enable_recording: false, // Włącz jeśli chcesz nagrywać
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // Wygasa za 24h
    }
  } = options;

  try {
    const response = await axios.post(
      `${DAILY_API_URL}/rooms`,
      {
        name,
        privacy,
        properties
      },
      {
        headers: {
          'Authorization': `Bearer ${DAILY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Daily.co createRoom error:', error.response?.data || error.message);
    throw new Error(`Błąd tworzenia pokoju Daily.co: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Tworzy token dla uczestnika pokoju
 * @param {String} roomName - Nazwa pokoju
 * @param {Object} options - Opcje tokena
 * @returns {Promise<String>} - Token JWT
 */
async function createToken(roomName, options = {}) {
  if (!DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY nie jest skonfigurowany');
  }

  const {
    userId,
    userName,
    isOwner = false,
    exp = Math.floor(Date.now() / 1000) + (2 * 60 * 60) // Wygasa za 2h
  } = options;

  try {
    const response = await axios.post(
      `${DAILY_API_URL}/meeting-tokens`,
      {
        properties: {
          room_name: roomName,
          user_id: userId,
          user_name: userName,
          is_owner: isOwner,
          exp
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${DAILY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.token;
  } catch (error) {
    console.error('Daily.co createToken error:', error.response?.data || error.message);
    throw new Error(`Błąd tworzenia tokena Daily.co: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Pobiera informacje o pokoju
 * @param {String} roomName - Nazwa pokoju
 * @returns {Promise<Object>} - Dane pokoju
 */
async function getRoom(roomName) {
  if (!DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY nie jest skonfigurowany');
  }

  try {
    const response = await axios.get(
      `${DAILY_API_URL}/rooms/${roomName}`,
      {
        headers: {
          'Authorization': `Bearer ${DAILY_API_KEY}`
        }
      }
    );

    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    console.error('Daily.co getRoom error:', error.response?.data || error.message);
    throw new Error(`Błąd pobierania pokoju Daily.co: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Usuwa pokój
 * @param {String} roomName - Nazwa pokoju
 * @returns {Promise<Boolean>}
 */
async function deleteRoom(roomName) {
  if (!DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY nie jest skonfigurowany');
  }

  try {
    await axios.delete(
      `${DAILY_API_URL}/rooms/${roomName}`,
      {
        headers: {
          'Authorization': `Bearer ${DAILY_API_KEY}`
        }
      }
    );

    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      return true; // Pokój już nie istnieje
    }
    console.error('Daily.co deleteRoom error:', error.response?.data || error.message);
    throw new Error(`Błąd usuwania pokoju Daily.co: ${error.response?.data?.error || error.message}`);
  }
}

/**
 * Pobiera nagrania z pokoju (jeśli włączone)
 * @param {String} roomName - Nazwa pokoju
 * @returns {Promise<Array>} - Lista nagrań
 */
async function getRecordings(roomName) {
  if (!DAILY_API_KEY) {
    throw new Error('DAILY_API_KEY nie jest skonfigurowany');
  }

  try {
    const response = await axios.get(
      `${DAILY_API_URL}/recordings?room_name=${roomName}`,
      {
        headers: {
          'Authorization': `Bearer ${DAILY_API_KEY}`
        }
      }
    );

    return response.data.data || [];
  } catch (error) {
    console.error('Daily.co getRecordings error:', error.response?.data || error.message);
    return [];
  }
}

module.exports = {
  createRoom,
  createToken,
  getRoom,
  deleteRoom,
  getRecordings,
  isConfigured: !!DAILY_API_KEY
};













