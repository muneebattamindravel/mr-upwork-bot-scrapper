require('dotenv').config();

const { app, session, screen } = require('electron');
const { createBrowserWindow } = require('./modules/browser');
const { solveCloudflareIfPresent } = require('./modules/cloudflareSolver');
const { scrapeJobFeed } = require('./modules/feedScraper');
const { scrapeJobDetail } = require('./modules/detailScraper');
const { sendHeartbeat } = require('./modules/heartbeat');
const { isLoginPage, shouldVisitJob, postJobToBackend } = require('./modules/utils');
const { getBotSettings } = require('./modules/botSettings');

const botId = process.env.BOT_ID || 'bot-001';

let win;
let settings;
let jobList = [];
let currentStatus = 'booting';
let currentMessage = '';
let currentJobUrl = '';

app.whenReady().then(async () => {

  settings = await getBotSettings(botId);

  // setInterval(() => {
  //   sendHeartbeat({
  //     status: currentStatus,
  //     message: currentMessage,
  //     jobUrl: currentJobUrl
  //   });
  // }, settings.heartbeatInterval);

  // win = await createBrowserWindow(session, screen);
  
  // console.log('[🧠 Bot Ready]');
  // await startCycle();
});

async function startCycle() {
  while (true) {
    try {
      settings = await getBotSettings(botId);
      await sendHeartbeat({ status: 'navigating_feed', message: 'Opening Upwork job feed' });

      const maxJobs = settings.maxJobsPerCycle || 50;
      const query = settings.queryString?.trim() || '';

      const baseUrl = new URL('https://www.upwork.com/nx/search/jobs/');
      baseUrl.searchParams.set('page', '1');
      baseUrl.searchParams.set('per_page', maxJobs.toString());
      baseUrl.searchParams.set('sort', 'recency');

      if (query) {
        const queryParts = new URLSearchParams(query);
        for (const [key, value] of queryParts.entries()) {
          baseUrl.searchParams.set(key, value);
        }
      }

      const url = baseUrl.toString();
      console.log(`🔍 Using Upwork URL: ${url}`);
      await win.loadURL(url);

      await wait(settings.feedWait || 5000);
      await solveCloudflareIfPresent(win, botId);

      if (await isLoginPage(win)) {
        console.warn('[Login Detected] Bot redirected to login!');
        await sendHeartbeat({ status: 'stuck', message: '⚠️ Bot stuck at login. Refresh cookies.', jobUrl: '' });
        return;
      }

      await sendHeartbeat({ status: 'scraping_feed', message: 'Extracting job links' });
      jobList = await scrapeJobFeed(win, botId);
      console.log(`🟡 Found ${jobList.length} jobs`);

      for (let i = 0; i < jobList.length; i++) {
        const job = jobList[i];

        const shouldVisit = await shouldVisitJob(job.url);
        if (!shouldVisit) {
          console.log(`[Skip] Job ${i + 1} already exists, skipping`);
          await wait(1000);
          continue;
        }

        await sendHeartbeat({ status: 'visiting_job_detail', message: job.title, jobUrl: job.url });
        const safeUrl = job.url.split('?')[0];

        try {
          await win.loadURL(safeUrl);
        } catch (err) {
          console.error('[❌ Load Error]', job.url, err.message);
          await sendHeartbeat({ status: 'job_load_failed', message: 'Failed to load job URL', jobUrl: job.url });
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
          console.log(`[Warn] Job ${i + 1} page may not be fully loaded. Waiting extra...`);
          await wait(settings.htmlWaitAfterShortLoad || 1500);
        }

        await sendHeartbeat({ status: 'scraping_job', message: `Scraping job ${i + 1}`, jobUrl: job.url });

        const details = await scrapeJobDetail(i, job.url);
        jobList[i] = { ...job, ...details };

        console.log(`[✅ Scraped Job ${i + 1}]`, jobList[i]);

        await sendHeartbeat({ status: 'saving_to_db', message: `Posting job ${i + 1} to backend`, jobUrl: job.url });
        await postJobToBackend(jobList[i]);

        const minDelay = settings.jobScrapeDelayMin || 1000;
        const maxDelay = settings.jobScrapeDelayMax || 2000;

        const delayBetweenJobs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
        console.log(`[Delay] Waiting ${delayBetweenJobs}ms between jobs...`);
        await wait(delayBetweenJobs);
      }

      await sendHeartbeat({ status: 'cycle_complete', message: `Cycle complete — scraped ${jobList.length} jobs` });

      const minCycleDelay = settings.cycleDelayMin || 20000;
      const maxCycleDelay = settings.cycleDelayMax || 40000;

      const delay = minCycleDelay + Math.floor(Math.random() * (maxCycleDelay - minCycleDelay));
      console.log(`[Cycle] Waiting ${delay / 1000}s before next cycle...`);

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
