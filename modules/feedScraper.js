const { getBotSettings } = require('./botSettings');
const { sendHeartbeat } = require('./heartbeat');
const { log } = require('./utils');

let jobList = [];

async function scrapeJobFeed(win, botId) {
  try {
    const settings = await getBotSettings(botId);
    // Use perPage — matches the per_page URL param set in main.js.
    // maxJobsPerCycle was a legacy field; old DB documents may still have it but it is ignored.
    const maxJobs = settings.perPage || 50;

    log(`[Feed] Scraping up to ${maxJobs} jobs from feed...`);
    jobList = await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('a[href*="/jobs/"]'))
        .filter(a => {
          // Strip query params before checking — job cards have:
          //   href="/jobs/Title_~ID/?referrer_url_path=/nx/search/jobs/"
          // The referrer param contains '/search/jobs/' so we MUST strip
          // query params first or every job link gets incorrectly excluded.
          const path = a.href.split('?')[0];
          return path.includes('~')        // job IDs always contain ~
            && !path.includes('/nx/')      // excludes /nx/search/jobs/ category pages
            && a.innerText.trim().length > 10;
        })
        .slice(0, ${maxJobs})
        .map(a => ({
          title: a.innerText.trim(),
          url: a.href.split('?')[0]        // clean URL, no referrer junk
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
