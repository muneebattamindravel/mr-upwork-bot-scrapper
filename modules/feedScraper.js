const { getBotSettings } = require('./botSettings');
const { sendHeartbeat } = require('./heartbeat');
const { log } = require('./utils');

let jobList = [];

async function scrapeJobFeed(win, botId) {
  try {
    const settings = await getBotSettings(botId);
    const maxJobs = settings.maxJobsPerCycle || 50;

    log(`[Feed] Scraping up to ${maxJobs} jobs from feed...`);
    // [FIX S2] Target job card articles by data-test="JobTile", then extract
    // the title link inside. Strip referrer query param from URL.
    // Old selector (broken — also grabbed /nx/search/jobs/ pagination links):
    // Array.from(document.querySelectorAll('a'))
    //   .filter(a => a.href.includes('/jobs/') && a.innerText.trim().length > 10)
    jobList = await win.webContents.executeJavaScript(`
      (() => {
        const tiles = Array.from(document.querySelectorAll('article[data-test="JobTile"]'));
        return tiles.slice(0, ${maxJobs}).map(tile => {
          const anchor = tile.querySelector('a[data-test="job-tile-title-link"]');
          if (!anchor) return null;
          const href = anchor.getAttribute('href');
          const rawUrl = href.startsWith('http') ? href : 'https://www.upwork.com' + href;
          const url = rawUrl.split('?')[0];
          const title = anchor.innerText.trim();
          return { title, url };
        }).filter(Boolean);
      })()
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
