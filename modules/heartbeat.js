const axios = require('axios');
const { getBotSettings } = require('./botSettings');

const backendUrl = `http://${process.env.SERVER_URL}`;
const botId = process.env.BOT_ID || 'default-bot';

async function sendHeartbeat({ status, message = '', jobUrl = '' }) {
  try {

    await axios.post(`${backendUrl}/api/bots/heartbeat`, {
      botId,
      status,
      message,
      jobUrl,
      timestamp: new Date().toISOString(),
    });

    console.log(`[📡 Heartbeat] ${status} — ${message}`);
  } catch (err) {
    console.warn('[⚠️ Heartbeat Failed]', err.message);
  }
}

module.exports = {
  sendHeartbeat,
};
