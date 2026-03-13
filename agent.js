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

const PORT = 4001;
app.listen(PORT, () => {
  log(`🤖 Bot agent listening at http://localhost:${PORT}`);
  registerWithDashboard();
  startCommandPolling();
});

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

    let currentStatus = botWindowPid ? 'running' : 'stopped';
    log(`Bot Status : `, currentStatus);

    return res.status(200).json({
      success: true,
      message: 'Bot status fetched',
      data: {
        status: currentStatus,
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

app.post('/start-bot', async (req, res) => {
  if (botWindowPid) {
    const alive = await isPidAlive(botWindowPid);
    if (alive) {
      return res.json({
        success: true,
        message: 'Bot already running',
        data: { pid: botWindowPid }
      });
    } else {
      botWindowPid = null;
    }
  }

  try {
    spawn('cmd.exe', ['/c', 'start', '"UPWORK_SCRAPER_BOT_WINDOW"', 'cmd', '/k', BAT_PATH], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref();

    log('[🟡 BOT LAUNCHING...]');

    // ✅ Delay without exiting early
    await new Promise(resolve => setTimeout(resolve, 2500));

    const wmicCommand = `wmic process where "CommandLine like '%--bot-tag=${BOT_TAG}%'" get ProcessId`;
    exec(wmicCommand, async (err, stdout) => {
      if (err) {
        console.error('[❌ PID DETECTION FAILED]', err.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to detect PID',
          error: err.message
        });
      }

      const match = stdout.match(/(\d+)/g);
      if (match && match.length > 0) {
        botWindowPid = parseInt(match[0]);
        log(`[✅ BOT STARTED] PID: ${botWindowPid}`);

        //await updateStatusOnDashboard('healthy', 'Bot started from agent');

        return res.json({
          success: true,
          message: '✅ Bot started',
          data: { pid: botWindowPid }
        });
      } else {
        log('[⚠️ BOT STARTED but PID not found]');
        return res.json({
          success: false,
          message: '⚠️ Bot started, but PID not found',
          data: {}
        });
      }
    });

  } catch (error) {
    console.error('[❌ BOT START ERROR]', error.message);
    return res.status(500).json({
      success: false,
      message: 'Bot start failed',
      error: error.message
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
      log('[❌ STOP ERROR]', stderr || err.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to stop bot',
        data: { error: stderr || err.message }
      });
    }

    log(`[🛑 BOT STOPPED]`);
    botWindowPid = null;

    //('offline', 'Bot stopped from agent');

    return res.status(200).json({
      success: true,
      message: '✅ Bot stopped successfully',
      data: null
    });
  });
});

// ── Command polling ────────────────────────────────────────────────────────────
// Polls brain every 5s for a pending 'start' or 'stop' command queued by the
// dashboard. This avoids the brain needing to reach EC2 port 4001 directly.
function startCommandPolling() {
  const POLL_INTERVAL = 5000;
  const botId = process.env.BOT_ID;

  setInterval(async () => {
    try {
      const res = await axios.get(
        `${process.env.BRAIN_BASE_URL}/bots/poll-command/${botId}`,
        { timeout: 4000 }
      );
      const command = res.data?.data?.command;

      if (command === 'start') {
        log('[Agent] Received start command from brain');
        if (botWindowPid) {
          const alive = await isPidAlive(botWindowPid);
          if (alive) { log('[Agent] Bot already running, ignoring start'); return; }
          botWindowPid = null;
        }
        spawn('cmd.exe', ['/c', 'start', '"UPWORK_SCRAPER_BOT_WINDOW"', 'cmd', '/k', BAT_PATH], {
          detached: true, stdio: 'ignore', shell: true,
        }).unref();
        log('[Agent] Bot start command executed');

      } else if (command === 'stop') {
        log('[Agent] Received stop command from brain');
        const killCmd = botWindowPid
          ? `taskkill /PID ${botWindowPid} /T /F`
          : `taskkill /FI "WINDOWTITLE eq UPWORK_SCRAPER_BOT_WINDOW" /T /F`;
        exec(killCmd, (err) => {
          if (err) log('[Agent] Stop error:', err.message);
          else log('[Agent] Bot stopped');
        });
        botWindowPid = null;
      }
    } catch (err) {
      // Polling failures are non-fatal — log only unexpected errors
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET') {
        log('[Agent] Poll error:', err.message);
      }
    }
  }, POLL_INTERVAL);
}

// 🔁 Register bot with dashboard (on start only);;
async function registerWithDashboard() {
  const port = PORT;
  const ip = await getPublicIP();

  try {

    const finalURL = `${process.env.BRAIN_BASE_URL}/bots/register`
    console.log(`Final URL ${finalURL}`)

    const res = await axios.post(finalURL, {
      botId: process.env.BOT_ID,
      ip,
      port,
    });

    log('[🔗 Bot Registered] ', res.data);
  } catch (err) {
    console.error('[❌ Registration Failed]', err.message);
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
