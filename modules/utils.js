const axios = require('axios');
const fs = require('fs');
const path = require('path');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(' ')}`;

  log(`🪵`, ...args);

  try {
    fs.appendFileSync(LOG_FILE, message + '\n', 'utf8');
  } catch (err) {
    console.error('❌ Failed to write log to file:', err.message);
  }
}

async function shouldVisitJob(url) {
  try {
    const response = await axios.post(`http://${process.env.SERVER_URL}/api/jobs/shouldVisit`, {
      url: url.split('?')[0]
    });
    return response.data?.visit === true;
  } catch (err) {
    console.error(`[shouldVisitJob] Error checking job existence: ${err.message}`);
    return false;
  }
}

async function postJobToBackend(jobData) {
  try {
    jobData.url = jobData.url.split('?')[0];
    const response = await axios.post(`http://${process.env.SERVER_URL}/api/jobs/ingest`, [jobData]);

    const insertedCount = response.data?.inserted || 1;
    log(`✅ Job posted: ${insertedCount} job(s)`);
  } catch (err) {
    console.error('❌ Failed to post job:', err.message);
  }
}

async function isLoginPage(win) {
  const currentURL = win.webContents.getURL();
  return currentURL.includes('/login') || currentURL.includes('account-security');
}

const cleanDollarValue = (val) => {
  if (!val || typeof val !== 'string') return 0;

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
