const axios = require('axios');
const { log } = require('./utils');

let cachedSettings = null;
let lastFetched = 0;
const CACHE_DURATION_MS = 30 * 1000;

async function getBotSettings(botId) {
  try {
    const now = Date.now();

    if (cachedSettings && (now - lastFetched < CACHE_DURATION_MS)) {
      return cachedSettings;
    }

    console.log(`calling ${process.env.BRAIN_BASE_URL}/bots/settings/${botId}`)
    const response = await axios.get(`${process.env.BRAIN_BASE_URL}/bots/settings/${botId}`);
    console.log(`settings response: `, response);

    if (response.data?.success === true && response.data?.data) {
      cachedSettings = response.data.data;
      lastFetched = now;

      return cachedSettings;
    } else {
      log('[⚠️ Bot Settings] Response malformed or not successful');
      return cachedSettings || {};
    }
  } catch (err) {
    console.error('[❌ Bot Settings Fetch Failed]', err.message);
    return cachedSettings || {};
  }
}

module.exports = { getBotSettings };
