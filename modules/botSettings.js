const axios = require('axios');

let cachedSettings = null;
let lastFetched = 0;
const CACHE_DURATION_MS = 30 * 1000;

async function getBotSettings(botId) {
  try {
    const now = Date.now();

    if (cachedSettings && (now - lastFetched < CACHE_DURATION_MS)) {
      return cachedSettings;
    }
    
    const response = await axios.get(`http://${process.env.SERVER_URL}/api/bot-settings/${botId}`);
    if (response.data && response.success) {
      cachedSettings = response.data;
      lastFetched = now;

      console.log(`return settings`, cachedSettings)
      return cachedSettings;
    } else {
      console.warn('[⚠️ Bot Settings] Response malformed or not successful');
      return cachedSettings || {};
    }
  } catch (err) {
    console.error('[❌ Bot Settings Fetch Failed]', err.message);
    return cachedSettings || {};
  }
}

module.exports = { getBotSettings };
