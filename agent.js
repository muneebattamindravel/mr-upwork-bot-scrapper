const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const https = require('https');

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

console.log(`🤖 Loaded BOT_TAG: ${BOT_TAG}`);

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
  if (botWindowPid) {
    const alive = await isPidAlive(botWindowPid);
    if (!alive) botWindowPid = null;
  }

  res.json({ status: botWindowPid ? 'running' : 'stopped', pid: botWindowPid });
});

app.post('/start-bot', async (req, res) => {
  if (botWindowPid) {
    const alive = await isPidAlive(botWindowPid);
    if (alive) {
      return res.json({ message: 'Bot already running', pid: botWindowPid });
    } else {
      botWindowPid = null;
    }
  }

  spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', BAT_PATH], {
    detached: true,
    shell: true,
  });

  console.log('[🟡 BOT LAUNCHING...]');

  setTimeout(() => {
    const wmicCommand = `wmic process where "CommandLine like '%--bot-tag=${BOT_TAG}%'" get ProcessId`;

    exec(wmicCommand, async (err, stdout) => {
      if (err) {
        console.error('[❌ PID DETECTION FAILED]', err.message);
        return res.status(500).json({ message: 'Failed to detect PID', error: err.message });
      }

      const match = stdout.match(/(\d+)/g);
      if (match && match.length > 0) {
        botWindowPid = parseInt(match[0]);
        console.log(`[✅ BOT STARTED] PID: ${botWindowPid}`);
        res.json({ message: `✅ Bot started`, pid: botWindowPid });

        await registerWithDashboard();
        await updateStatusOnDashboard('healthy', 'Bot started from agent');
      } else {
        console.warn('[⚠️ BOT STARTED but PID not found]');
        res.json({ message: '⚠️ Bot started, but PID not found' });
      }
    });
  }, 2500);
});

app.post('/stop-bot', (req, res) => {
  const killCommand = botWindowPid
    ? `taskkill /PID ${botWindowPid} /T /F`
    : `taskkill /FI "WINDOWTITLE eq UPWORK_SCRAPER_BOT_WINDOW" /T /F`;

  console.log('[🛑 STOP COMMAND]', killCommand);

  exec(killCommand, async (err, stdout, stderr) => {
    if (err) {
      console.error('[❌ STOP ERROR]', stderr || err.message);
      return res.status(500).json({ message: 'Failed to stop bot', error: stderr || err.message });
    }

    console.log(`[🛑 BOT STOPPED]`);
    botWindowPid = null;
    res.json({ message: '✅ Bot stopped successfully' });

    await updateStatusOnDashboard('offline', 'Bot stopped from agent');
  });
});

const PORT = 4001;
app.listen(PORT, () => {
  console.log(`🤖 Bot agent listening at http://localhost:${PORT}`);
});

// 🔁 Register bot with dashboard (on start only)
async function registerWithDashboard() {
  const port = PORT;
  const ip = await getPublicIP();

  try {
    const res = await axios.post(`http://${process.env.SERVER_URL}/api/bots/register`, {
      botId: BOT_ID,
      ip,
      port,
    });

    console.log('[🔗 Bot Registered]', res.data.message);
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

    console.log(`[📣 Status Updated] ${status}`);
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
