const axios = require('axios');
const { log } = require('./utils');

const botId = process.env.BOT_ID || 'default-bot';

let currentStatus = 'booting';
let currentMessage = '';
let currentJobUrl = '';

async function sendHeartbeat({ status = '', message = '', jobUrl = '', statsInc = null, statsSet = null }) {
  try {
    currentStatus = status || currentStatus;
    currentMessage = message || currentMessage;
    currentJobUrl = jobUrl || currentJobUrl;

    const cleanURL = currentJobUrl?.split('?')[0] || '';

    const payload = {
      botId,
      status: currentStatus,
      message: currentMessage,
      jobUrl: cleanURL,
      timestamp: new Date().toISOString()
    };
    if (statsInc) payload.statsInc = statsInc;
    if (statsSet)  payload.statsSet  = statsSet;

    await axios.post(`${process.env.BRAIN_BASE_URL}/bots/heartbeat`, payload);

    log(`[📡 Heartbeat] ${currentStatus} — ${currentMessage}`);
  } catch (err) {
    log('[⚠️ Heartbeat Failed]', err.message);
  }
}

function startHeartbeatInterval(interval = 10000) {
  setInterval(() => {
    sendHeartbeat({});
  }, interval);
}

module.exports = {
  sendHeartbeat,
  startHeartbeatInterval
};
