const { getBotSettings } = require('./botSettings');
const { sendHeartbeat } = require('./heartbeat');
const { log } = require('./utils');

let jobList = [];

async function scrapeJobFeed(win, botId) {
  try {
    const settings = await getBotSettings(botId);
    // Use perPage (how many jobs Upwork returns per feed page) — matches the
    // per_page URL param set in main.js. maxJobsPerCycle is a legacy fallback.
    const maxJobs = settings.perPage || settings.maxJobsPerCycle || 50;

    log(`[Feed] Scraping up to ${maxJobs} jobs from feed...`);
    jobList = await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('a'))
        .filter(a => a.href.includes('/jobs/') && a.innerText.trim().length > 10)
        .slice(0, ${maxJobs})
        .map(a => ({
          title: a.innerText.trim(),
          url: a.href.startsWith('http') ? a.href : 'https://www.upwork.com' + a.getAttribute('href')
        }));
    `);

    log(`[Feed] Found ${jobList.length} valid job links.`);
    return jobList || [];
  } catch (err) {
    console.error('[❌ Feed Scrape Error]', err.message);
    await sendHeartbeat({ status: 'feed_scrape_error', message: err.message });
    return [];
  }
}

module.exports = { scrapeJobFeed };
