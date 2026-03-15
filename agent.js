// v2.1.0 — agent keep-alive + separate agent/scraper status tracking
const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const https = require('https');
const { io: ioClient } = require('socket.io-client');
const { log } = require('./modules/utils');

const app = express();
app.use(cors());
app.use(express.json());

dotenv.config({ path: path.join(__dirname, '.env') });

const BOT_TAG = 'ec2-t2micro-scraper-bot';
const BOT_ID = process.env.BOT_ID || 'unknown-bot';
const BAT_PATH = path.join(__dirname, 'start-bot.bat');

let botWindowPid = null;

// socketRef lets the polling fallback check socket.connected without a closure issue
const socketRef = { current: null };

const PORT = 4001;
app.listen(PORT, () => {
  log(`🤖 Bot agent listening at http://localhost:${PORT}`);
  registerWithDashboard();
  socketRef.current = startBrainSocket();
  startCommandPolling(socketRef);
  startAgentKeepAlive();
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
  try {
    await executeStart();
    return res.json({ success: true, message: '✅ Bot start initiated', data: {} });
  } catch (error) {
    console.error('[❌ BOT START ERROR]', error.message);
    return res.status(500).json({ success: false, message: 'Bot start failed', error: error.message });
  }
});

// ✅ Stop Bot
app.post('/stop-bot', (req, res) => {
  executeStop(socketRef.current);
  return res.status(200).json({ success: true, message: '✅ Stop command executed', data: null });
});

// ── Shared start/stop execution (used by both socket and HTTP endpoints) ──────

async function executeStart() {
  if (botWindowPid) {
    const alive = await isPidAlive(botWindowPid);
    if (alive) { log('[Agent] Bot already running, ignoring start'); return; }
    botWindowPid = null;
  }
  spawn('cmd.exe', ['/c', 'start', '"UPWORK_SCRAPER_BOT_WINDOW"', 'cmd', '/k', BAT_PATH], {
    detached: true, stdio: 'ignore', shell: true,
  }).unref();
  log('[Agent] Bot start command executed');
  // Capture PID so stop can use taskkill /PID reliably
  setTimeout(() => {
    const wmicCommand = `wmic process where "CommandLine like '%--bot-tag=${BOT_TAG}%'" get ProcessId`;
    exec(wmicCommand, (err, stdout) => {
      if (err) { log('[Agent] PID detection error:', err.message); return; }
      const match = stdout.match(/(\d+)/g);
      if (match && match.length > 0) {
        botWindowPid = parseInt(match[0]);
        log(`[Agent] Bot PID captured: ${botWindowPid}`);
      } else {
        log('[Agent] Bot started but PID not found via wmic');
      }
    });
  }, 2500);
}

function executeStop(socket) {
  const killCmd = botWindowPid
    ? `taskkill /PID ${botWindowPid} /T /F`
    : `taskkill /FI "WINDOWTITLE eq UPWORK_SCRAPER_BOT_WINDOW" /T /F`;
  exec(killCmd, (err) => {
    if (err) {
      log('[Agent] Stop error:', err.message);
      if (socket) socket.emit('agent:command_result', { botId: BOT_ID, command: 'stop', success: false });
    } else {
      log('[Agent] Bot stopped');
      if (socket) socket.emit('agent:command_result', { botId: BOT_ID, command: 'stop', success: true });
    }
  });
  botWindowPid = null;
}

// ── Socket.IO connection to brain ─────────────────────────────────────────────
// Primary channel for receiving commands (instant delivery).
// Falls back to HTTP polling if socket is disconnected.
function startBrainSocket() {
  const BRAIN_URL = process.env.BRAIN_BASE_URL;
  if (!BRAIN_URL) { log('[Socket] BRAIN_BASE_URL not set — skipping socket'); return null; }

  // Derive the socket origin (strip the /up-bot-brain-api path if present)
  const socketOrigin = BRAIN_URL.replace(/\/up-bot-brain-api\/?$/, '');

  const socket = ioClient(socketOrigin, {
    path: '/up-bot-brain-api/socket.io',
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    log(`[Socket] Connected to brain (id=${socket.id})`);
    socket.emit('agent:register', { botId: BOT_ID });
  });

  socket.on('bot:command', async ({ command }) => {
    log(`[Socket] Received command: ${command}`);
    if (command === 'start') {
      await executeStart();
    } else if (command === 'stop') {
      executeStop(socket);
    }
  });

  socket.on('disconnect', (reason) => log(`[Socket] Disconnected: ${reason}`));
  socket.on('connect_error', (err) => log(`[Socket] Connection error: ${err.message}`));

  return socket;
}

// ── HTTP polling fallback ─────────────────────────────────────────────────────
// Polls brain every 5s. Handles the rare case where the socket is temporarily
// disconnected and a command was queued in the DB during that window.
function startCommandPolling(socketRef) {
  const POLL_INTERVAL = 5000;
  const botId = process.env.BOT_ID;

  setInterval(async () => {
    // Skip poll while socket is connected — socket already handles commands instantly
    if (socketRef.current?.connected) return;

    try {
      const res = await axios.get(
        `${process.env.BRAIN_BASE_URL}/bots/poll-command/${botId}`,
        { timeout: 4000 }
      );
      const command = res.data?.data?.command;
      if (command === 'start') {
        log('[Agent:Poll] Received start command');
        await executeStart();
      } else if (command === 'stop') {
        log('[Agent:Poll] Received stop command');
        executeStop(null);
      }
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET') {
        log('[Agent:Poll] Error:', err.message);
      }
    }
  }, POLL_INTERVAL);
}

// 🔁 Agent keep-alive ping — runs every 30s, independent of scraper heartbeats.
// This lets the brain distinguish "agent up but scraper stopped" vs "EC2 down".
function startAgentKeepAlive() {
  const botId = process.env.BOT_ID;
  const brainUrl = process.env.BRAIN_BASE_URL;
  if (!botId || !brainUrl) return;

  const ping = async () => {
    try {
      await axios.post(`${brainUrl}/bots/agent-heartbeat`, { botId }, { timeout: 4000 });
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET') {
        log('[Agent:KeepAlive] Error:', err.message);
      }
    }
  };

  // Fire immediately on start, then every 30s
  ping();
  setInterval(ping, 30000);
}

// 🔁 Register bot with dashboard (on start only);;
async function registerWithDashboard() {
  const port = PORT;
  const ip = await getPublicIP();

  try {

    const finalURL = `${process.env.BRAIN_BASE_URL}/bots/register`

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
