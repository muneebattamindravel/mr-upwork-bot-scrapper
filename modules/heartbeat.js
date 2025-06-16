const axios = require('axios');
const { getBotSettings } = require('./botSettings');

const backendUrl = `http://${process.env.SERVER_URL}`;
const botId = process.env.BOT_ID || 'default-bot';

let lastHeartbeatTime = 0;

async function sendHeartbeat({ status, message = '', jobUrl = '' }) {
  try {
    const settings = await getBotSettings(botId);
    const interval = settings.heartbeatInterval || 10000;

    const now = Date.now();
    if (now - lastHeartbeatTime < interval) return;

    lastHeartbeatTime = now;

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
