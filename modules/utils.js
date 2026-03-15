const axios = require('axios');
const fs = require('fs');
const path = require('path');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ❌ Delete old log file at startup
if (fs.existsSync(LOG_FILE)) {
  fs.unlinkSync(LOG_FILE);
}

// ✅ Create a fresh empty log file
fs.writeFileSync(LOG_FILE, '', 'utf-8');
function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(' ')}`;

  console.log(`🪵`, ...args);

  try {
    // fs.appendFileSync(LOG_FILE, message + '\n', 'utf8');
  } catch (err) {
    console.error('❌ Failed to write log to file:', err.message);
  }
}

async function shouldVisitJob(url) {
  try {
    const response = await axios.post(`${process.env.BRAIN_BASE_URL}/jobs/shouldVisit`, {
      url: url.split('?')[0]
    });

    const shouldVisit = response.data?.data?.shouldVisit === true;

    log(`🟡 shouldVisitJob(${url}) → ${shouldVisit}`);

    return shouldVisit;
  } catch (err) {
    // Network error or brain API down — default to TRUE (visit the job) so we
    // never silently skip a job due to a transient failure. Worst case: a dupe
    // gets sent to ingest, which handles dedup via upsert anyway.
    console.error(`[shouldVisitJob] Error — defaulting to visit: ${err.message}`);
    return true;
  }
}


async function postJobToBackend(jobData, retries = 1) {
  try {
    jobData.url = jobData.url.split('?')[0];
    jobData.botId = process.env.BOT_ID;

    const response = await axios.post(`${process.env.BRAIN_BASE_URL}/jobs/ingest`, [jobData]);

    const insertedCount = response.data?.inserted || 1;
    log(`✅ Job posted: ${insertedCount} job(s)`);
  } catch (err) {
    console.error(`❌ Failed to post job (${retries} retries left): ${err.message}`);
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return postJobToBackend(jobData, retries - 1);
    }
    // Re-throw after all retries exhausted so main.js cycle error handler is aware
    throw err;
  }
}

async function isLoginPage(win) {
  const currentURL = win.webContents.getURL();
  return currentURL.includes('/login') || currentURL.includes('account-security');
}

const cleanDollarValue = (val) => {
  if (val === null || val === undefined) return 0;

  const cleaned = val.toString().trim().replace(/[$,]/g, '').toUpperCase();

  let multiplier = 1;
  let numberStr = cleaned;

  if (cleaned.endsWith('K')) {
    multiplier = 1000;
    numberStr = cleaned.replace(/K$/, '');
  } else if (cleaned.endsWith('M')) {
    multiplier = 1000000;
    numberStr = cleaned.replace(/M$/, '');
  }

  const num = parseFloat(numberStr);
  return isNaN(num) ? 0 : num * multiplier;
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  shouldVisitJob,
  postJobToBackend,
  isLoginPage,
  cleanDollarValue,
  wait,
  log
};
