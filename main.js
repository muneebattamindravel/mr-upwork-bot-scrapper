require('dotenv').config();

const { app, session, screen } = require('electron');
const { createBrowserWindow } = require('./modules/browser');
const { solveCloudflareIfPresent } = require('./modules/cloudflareSolver');
const { scrapeJobFeed } = require('./modules/feedScraper');
const { scrapeJobDetail } = require('./modules/detailScraper');
const { sendHeartbeat, startHeartbeatInterval } = require('./modules/heartbeat');
const { isLoginPage, shouldVisitJob, postJobToBackend, wait, log } = require('./modules/utils');
const { getBotSettings } = require('./modules/botSettings');

const botId = process.env.BOT_ID || 'bot-001';

let win;
let settings;
let jobList = [];

app.whenReady().then(async () => {
  settings = await getBotSettings(botId);

  startHeartbeatInterval(settings.heartbeatInterval);
  win = await createBrowserWindow(session, screen);
  log('[🧠 Bot Ready]');
  await startCycle();
});

async function startCycle() {
  while (true) {
    try {
      settings = await getBotSettings(botId);
      await sendHeartbeat({ status: 'navigating_feed', message: 'Opening Upwork job feed' });

      const maxJobs = settings.perPage || 50;
      const query = settings.searchQuery?.trim() || '';

      const baseUrl = new URL('https://www.upwork.com/nx/search/jobs/');
      baseUrl.searchParams.set('page', '1');
      baseUrl.searchParams.set('per_page', maxJobs.toString());
      baseUrl.searchParams.set('sort', 'recency');

      if (query) {
        baseUrl.searchParams.set('q', query);
      }

      const url = baseUrl.toString();
      log(`🔍 Using Upwork URL: ${url}`);

      await win.loadURL(url);

      await wait(settings.feedWait || 5000);
      await solveCloudflareIfPresent(win, botId);

      if (await isLoginPage(win)) {
        log('[Login Detected] Bot redirected to login!');
        await sendHeartbeat({ status: 'login_detected', message: '⚠️ Bot stuck at login. Refresh cookies.', jobUrl: '' });
        return;
      }

      await sendHeartbeat({ status: 'scraping_feed', message: 'Extracting job links' });
      jobList = await scrapeJobFeed(win, botId);
      log(`🟡 Found ${jobList.length} jobs`);

      for (let i = 0; i < jobList.length; i++) {
        const job = jobList[i];

        const shouldVisit = await shouldVisitJob(job.url.split('?')[0]);
        if (!shouldVisit) {
          log(`[Skip] Job ${i + 1} already exists, url = `, job.url.split('?')[0]);
          await wait(1000);
          continue;
        }

        await sendHeartbeat({ status: 'visiting_job_detail', message: job.title, jobUrl: job.url.split('?')[0] });
        const safeUrl = job.url.split('?')[0];

        try {
          await win.loadURL(safeUrl);
        } catch (err) {
          console.error('[❌ Load Error]', job.url.split('?')[0], err.message);
          await sendHeartbeat({ status: 'job_load_failed', message: 'Failed to load job URL', jobUrl: job.url.split('?')[0] });
          continue;
        }

        const preScrapeMin = settings.jobDetailPreScrapeDelayMin || 2000;
        const preScrapeMax = settings.jobDetailPreScrapeDelayMax || 3000;

        // Add race between randomized wait and Cloudflare check
        await Promise.race([
          wait(preScrapeMin + Math.floor(Math.random() * (preScrapeMax - preScrapeMin))),
          solveCloudflareIfPresent(win, botId)
        ]);

        // Sanity check – HTML loaded or fallback wait
        const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
        const htmlThreshold = settings.htmlLengthThreshold || 10000;

        if (htmlLengthCheck < htmlThreshold) {
          log(`[Warn] Job ${i + 1} page may not be fully loaded. Waiting extra...`);
          await wait(settings.waitIfHtmlThresholdFailded || 1500);
        }

        await sendHeartbeat({ status: 'scraping_job', message: `Scraping job ${i + 1}`, jobUrl: job.url.split('?')[0] });

        const details = await scrapeJobDetail(win, i, job.url.split('?')[0]);
        jobList[i] = { ...job, ...details };

        log(`[✅ Scraped Job ${i + 1}]`, jobList[i]);

        await sendHeartbeat({ status: 'saving_to_db', message: `Posting job ${i + 1} to backend`, jobUrl: job.url.split('?')[0] });
        await postJobToBackend(jobList[i]);

        const minDelay = settings.delayBetweenJobsScrapingMin || 1000;
        const maxDelay = settings.delayBetweenJobsScrapingMax || 2000;

        const delayBetweenJobs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
        log(`[Delay] Waiting ${delayBetweenJobs}ms between jobs...`);
        await wait(delayBetweenJobs);
      }

      await sendHeartbeat({ status: 'cycle_complete', message: `Cycle complete — scraped ${jobList.length} jobs` });

      const minCycleDelay = settings.cycleDelayMin || 20000;
      const maxCycleDelay = settings.cycleDelayMax || 40000;

      const delay = minCycleDelay + Math.floor(Math.random() * (maxCycleDelay - minCycleDelay));
      log(`[Cycle] Waiting ${delay / 1000}s before next cycle...`);

      await sendHeartbeat({ status: 'idle', message: `Sleeping for ${delay / 1000}s before next cycle` });
      await wait(delay);
      jobList = [];

    } catch (err) {
      console.error('[❌ Cycle Error]', err.message);
      await sendHeartbeat({ status: 'cycle_error', message: err.message });
      await wait(15000);
    }
  }
}
