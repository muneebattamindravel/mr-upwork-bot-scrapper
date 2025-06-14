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

// ✅ Load .env from same folder
dotenv.config({ path: path.join(__dirname, '.env') });

// ✅ Use bot tag from .env
const BOT_TAG = process.env.BOT_TAG;
const BAT_PATH = path.join(__dirname, 'start-bot.bat');

let botWindowPid = null;

// ✅ Sanity check
if (!BOT_TAG) {
  console.error('❌ BOT_TAG not found in .env. Exiting...');
  process.exit(1);
}

console.log(`🤖 Loaded BOT_TAG: ${BOT_TAG}`);

app.get('/status', (req, res) => {
  res.json({ status: botWindowPid ? 'running' : 'stopped', pid: botWindowPid });
});

app.post('/start-bot', (req, res) => {
  if (botWindowPid) {
    return res.json({ message: 'Bot already running', pid: botWindowPid });
  }

  // ✅ Start .bat in new CMD window
  spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', BAT_PATH], {
    detached: true,
    shell: true,
  });

  console.log('[🟡 BOT LAUNCHING...]');

  setTimeout(() => {
    // ✅ Look for Electron process with matching tag
    const wmicCommand = `wmic process where "CommandLine like '%--bot-tag=${BOT_TAG}%'" get ProcessId`;

    exec(wmicCommand, (err, stdout) => {
      if (err) {
        console.error('[❌ PID DETECTION FAILED]', err.message);
        return res.status(500).json({ message: 'Failed to detect PID', error: err.message });
      }

      const match = stdout.match(/(\d+)/g);
      if (match && match.length > 0) {
        botWindowPid = parseInt(match[0]);
        console.log(`[✅ BOT STARTED] PID: ${botWindowPid}`);
        res.json({ message: `✅ Bot started`, pid: botWindowPid });

        registerWithDashboard();
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

  exec(killCommand, (err, stdout, stderr) => {
    if (err) {
      console.error('[❌ STOP ERROR]', stderr || err.message);
      return res.status(500).json({ message: 'Failed to stop bot', error: stderr || err.message });
    }

    console.log(`[🛑 BOT STOPPED]`);
    botWindowPid = null;
    res.json({ message: '✅ Bot stopped successfully' });
  });
});


const PORT = 4001;
app.listen(PORT, () => {
  console.log(`🤖 Bot agent listening at http://localhost:${PORT}`);
});

async function registerWithDashboard() {
  const botId = process.env.BOT_ID || 'unknown-bot';
  const port = PORT;
  const ip = await getPublicIP();

  try {
    const res = await axios.post('http://52.71.253.188:3000/api/bots/register', {
      botId,
      ip,
      port
    });

    console.log('[🔗 Bot Registered]', res.data.message);
  } catch (err) {
    console.error('[❌ Registration Failed]', err.message);
  }
}


function getPublicIP() {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data.trim()));
    }).on('error', (err) => {
      console.error('[IP Fetch Error]', err.message);
      resolve('127.0.0.1'); // fallback
    });
  });
}

