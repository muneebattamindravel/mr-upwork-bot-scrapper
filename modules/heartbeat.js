const axios = require('axios');

const backendUrl = `http://${process.env.SERVER_URL}`;
const botId = process.env.BOT_ID || 'default-bot';

let currentStatus = 'booting';
let currentMessage = '';
let currentJobUrl = '';

async function sendHeartbeat({ status = '', message = '', jobUrl = '' }) {
  try {

    currentStatus = status;
    currentMessage = message;
    currentJobUrl = jobUrl;

    await axios.post(`${backendUrl}/api/bots/heartbeat`, {
      botId,
      status: status === '' ? currentStatus : status,
      message: message === '' ? currentMessage : message,
      jobUrl: jobUrl === '' ? currentJobUrl : jobUrl,
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
