const axios = require('axios');

const backendUrl = `http://${process.env.SERVER_URL}`;
const botId = process.env.BOT_ID || 'default-bot';

let currentStatus = 'booting';
let currentMessage = '';
let currentJobUrl = '';

async function sendHeartbeat({ status = '', message = '', jobUrl = '' }) {
  try {
    currentStatus = status || currentStatus;
    currentMessage = message || currentMessage;
    currentJobUrl = jobUrl || currentJobUrl;

    const cleanURL = currentJobUrl?.split('?')[0] || '';

    await axios.post(`${backendUrl}/api/bots/heartbeat`, {
      botId,
      status: currentStatus,
      message: currentMessage,
      jobUrl: cleanURL,
      timestamp: new Date().toISOString()
    });

    console.log(`[📡 Heartbeat] ${currentStatus} — ${currentMessage}`);
  } catch (err) {
    console.warn('[⚠️ Heartbeat Failed]', err.message);
  }
}

function startHeartbeatInterval(interval = 10000) {
  setInterval(() => {
    sendHeartbeat({}); // Use last known status/message/jobUrl
  }, interval);
}

module.exports = {
  sendHeartbeat,
  startHeartbeatInterval
};
