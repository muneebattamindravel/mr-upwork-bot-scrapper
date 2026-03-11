const { getBotSettings } = require('./botSettings');
const { sendHeartbeat } = require('./heartbeat');
const { log } = require('./utils');

async function scrapeJobFeed(win, botId) {
  try {
    const settings = await getBotSettings(botId);
    const maxJobs = settings.maxJobsPerCycle || 50;

    log(`[Feed] Scraping up to ${maxJobs} jobs from feed...`);
    const jobList = await win.webContents.executeJavaScript(`
      (() => {
        // Primary: structured job tile articles
        const tiles = Array.from(document.querySelectorAll('article[data-test="JobTile"]'));
        if (tiles.length > 0) {
          return tiles.slice(0, ${maxJobs}).map(tile => {
            const anchor = tile.querySelector('a[data-test="job-tile-title-link"]') || tile.querySelector('a[href*="/jobs/~"]');
            if (!anchor) return null;
            const href = anchor.getAttribute('href');
            const rawUrl = href.startsWith('http') ? href : 'https://www.upwork.com' + href;
            const url = rawUrl.split('?')[0];
            const title = anchor.innerText.trim();
            return { title, url };
          }).filter(Boolean);
        }

        // Fallback: all job links on the page, excluding feed/search/pagination URLs
        return Array.from(document.querySelectorAll('a'))
          .filter(a => a.href.includes('/jobs/~') && a.innerText.trim().length > 5)
          .slice(0, ${maxJobs})
          .map(a => ({
            title: a.innerText.trim(),
            url: a.href.split('?')[0]
          }));
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
