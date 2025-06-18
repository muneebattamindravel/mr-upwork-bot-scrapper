const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const https = require('https');
const { log } = require('./modules/utils');

const app = express();
app.use(cors());
app.use(express.json());

dotenv.config({ path: path.join(__dirname, '.env') });

const BOT_TAG = 'ec2-t2micro-scraper-bot';
const BOT_ID = process.env.BOT_ID || 'unknown-bot';
const BAT_PATH = path.join(__dirname, 'start-bot.bat');

let botWindowPid = null;

if (!BOT_TAG) {
  console.error('❌ BOT_TAG not found in .env. Exiting...');
  process.exit(1);
}

log(`🤖 Loaded BOT_TAG: ${BOT_TAG}`);

// ✅ Check if a PID is still alive
function isPidAlive(pid) {
  return new Promise((resolve) => {
    exec(`tasklist /FI "PID eq ${pid}"`, (err, stdout) => {
      if (err || !stdout.includes(`${pid}`)) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

app.get('/status', async (req, res) => {
  try {
    if (botWindowPid) {
      const alive = await isPidAlive(botWindowPid);
      if (!alive) botWindowPid = null;
    }

    return res.status(200).json({
      success: true,
      message: 'Bot status fetched',
      data: {
        status: botWindowPid ? 'running' : 'stopped',
        pid: botWindowPid || null
      }
    });
  } catch (err) {
    console.error('[Agent /status Error]', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bot status',
      data: null
    });
  }
});


// ✅ Stop Bot
app.post('/stop-bot', (req, res) => {
  const killCommand = botWindowPid
    ? `taskkill /PID ${botWindowPid} /T /F`
    : `taskkill /FI "WINDOWTITLE eq UPWORK_SCRAPER_BOT_WINDOW" /T /F`;

  log('[🛑 STOP COMMAND]', killCommand);

  exec(killCommand, async (err, stdout, stderr) => {
    if (err) {
      console.error('[❌ STOP ERROR]', stderr || err.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to stop bot',
        data: { error: stderr || err.message }
      });
    }

    log(`[🛑 BOT STOPPED]`);
    botWindowPid = null;

    await updateStatusOnDashboard('offline', 'Bot stopped from agent');

    return res.status(200).json({
      success: true,
      message: '✅ Bot stopped successfully',
      data: null
    });
  });
});



const PORT = 4001;
app.listen(PORT, () => {
  log(`🤖 Bot agent listening at http://localhost:${PORT}`);
  registerWithDashboard();
});

// 🔁 Register bot with dashboard (on start only);;
async function registerWithDashboard() {
  const port = PORT;
  const ip = await getPublicIP();

  try {
    const res = await axios.post(`http://${process.env.SERVER_URL}/api/bots/register`, {
      botId: BOT_ID,
      ip,
      port,
    });

    log('[🔗 Bot Registered]', res.data.message);
  } catch (err) {
    console.error('[❌ Registration Failed]', err.message);
  }
}

// 🔁 Update status (on start/stop)
async function updateStatusOnDashboard(status, message) {
  try {
    const res = await axios.post(`http://${process.env.SERVER_URL}/api/bots/update-health`, {
      botId: BOT_ID,
      status,
      message,
    });

    log(`[📣 Status Updated] ${status}`);
  } catch (err) {
    console.error('[❌ Update Status Failed]', err.message);
  }
}

// 🌐 Get public IP
function getPublicIP() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data.trim()));
    }).on('error', (err) => {
      console.error('[IP Fetch Error]', err.message);
      resolve('127.0.0.1');
    });
  });
}
