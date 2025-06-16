const axios = require('axios');

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
    console.log(`✅ Job posted: ${insertedCount} job(s)`);
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

module.exports = {
  shouldVisitJob,
  postJobToBackend,
  isLoginPage,
  cleanDollarValue
};
