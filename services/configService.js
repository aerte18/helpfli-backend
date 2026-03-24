// Prosty serwis konfiguracji - w produkcji możesz użyć Redis lub bazy danych
const configs = new Map();

async function getConfig(key) {
  return configs.get(key) || null;
}

async function setConfig(key, value) {
  configs.set(key, value);
  return value;
}

module.exports = { getConfig, setConfig };


























