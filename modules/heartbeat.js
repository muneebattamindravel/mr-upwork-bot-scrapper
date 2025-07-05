const axios = require('axios');
const { log } = require('./utils');

const backendUrl = `http://${process.env.SERVER_IP}`;
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

    let finalURL = `${backendUrl}/api/bots/heartbeat`;
    console.log(`FINAL URL : `, finalURL);
    
    await axios.post(`${backendUrl}/api/bots/heartbeat`, {
      botId,
      status: currentStatus,
      message: currentMessage,
      jobUrl: cleanURL,
      timestamp: new Date().toISOString()
    });

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
