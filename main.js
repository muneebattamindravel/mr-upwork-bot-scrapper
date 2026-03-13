require('dotenv').config();

const { app, session, screen } = require('electron');
const { createBrowserWindow, createBrowserWindowNoLogin } = require('./modules/browser');
const { solveCloudflareIfPresent } = require('./modules/cloudflareSolver');
const { scrapeJobFeed } = require('./modules/feedScraper');
const { scrapeJobDetail } = require('./modules/detailScraper');
const { sendHeartbeat, startHeartbeatInterval } = require('./modules/heartbeat');
const { /*isLoginPage,*/ shouldVisitJob, postJobToBackend, wait, log } = require('./modules/utils');
const { getBotSettings } = require('./modules/botSettings');

const botId = process.env.BOT_ID || 'bot-001';

let win;
let settings;
let jobList = [];

app.whenReady().then(async () => {
  settings = await getBotSettings(botId);
  //win = await createBrowserWindow(session, screen);
  win = await createBrowserWindowNoLogin(session, screen);
  startHeartbeatInterval(settings.heartbeatInterval);
  log('[🧠 Bot Ready]');
  await startCycle();
});

async function startCycle() {
  while (true) {
    try {

      jobList = [];
      jobList.length = 0;

      settings = await getBotSettings(botId);
      await sendHeartbeat({ status: 'navigating_feed', message: 'Opening Upwork job feed' });

      const maxJobs = settings.perPage || 50;

      // IMP S7: multi-query sweep — run ALL queries in one cycle for full tech coverage.
      // Falls back to legacy single searchQuery if searchQueries is empty.
      const queries = (settings.searchQueries && settings.searchQueries.length > 0)
        ? settings.searchQueries
        : (settings.searchQuery?.trim() ? [settings.searchQuery.trim()] : ['']);

      log(`[🔍 Multi-Query] Running ${queries.length} search queries this cycle`);

      let totalScraped = 0;

      for (let qi = 0; qi < queries.length; qi++) {
        const query = queries[qi].trim();

        log(`[Query ${qi + 1}/${queries.length}] "${query || '(all)'}"`);

        // If the entry is already a full URL (starts with http), use it directly
        // and just override per_page + sort + location_type so our settings apply.
        // Otherwise build from keyword as before.
        let url;
        if (query.startsWith('http')) {
          const builtUrl = new URL(query);
          builtUrl.searchParams.set('per_page', maxJobs.toString());
          builtUrl.searchParams.set('sort', 'recency');
          builtUrl.searchParams.set('location_type', 'worldwide');
          url = builtUrl.toString();
        } else {
          const baseUrl = new URL('https://www.upwork.com/nx/search/jobs/');
          baseUrl.searchParams.set('page', '1');
          baseUrl.searchParams.set('per_page', maxJobs.toString());
          baseUrl.searchParams.set('sort', 'recency');
          baseUrl.searchParams.set('location_type', 'worldwide');
          if (query) baseUrl.searchParams.set('q', query);
          url = baseUrl.toString();
        }

        log(`🔍 Feed URL: ${url}`);

        await sendHeartbeat({ status: 'navigating_feed', message: `Query ${qi + 1}/${queries.length}: "${query || 'all'}"` });
        await win.loadURL(url);

        await wait(settings.feedWait || 5000);
        await solveCloudflareIfPresent(win, botId);

        // [FIX S1] No-login mode — login redirect check disabled
        // if (await isLoginPage(win)) { ... }

        await sendHeartbeat({ status: 'scraping_feed', message: `Extracting jobs for "${query || 'all'}"` });
        jobList = await scrapeJobFeed(win, botId);
        log(`🟡 Query "${query}" — found ${jobList.length} jobs`);

        for (let i = 0; i < jobList.length; i++) {

          const job = jobList[i];

          // ✅ Skip any URL that is the feed page itself
          if (!job.url || job.url.split('?')[0].includes('/search/jobs/')) {
            log(`[Skip] Invalid or feed URL detected, skipping: ${job.url}`);
            continue;
          }

          const shouldVisit = await shouldVisitJob(job.url.split('?')[0]);
          if (!shouldVisit) {
            log(`[Skip] Already exists: ${job.url.split('?')[0]}`);
            await wait(300);
            continue;
          }

          await sendHeartbeat({ status: 'visiting_job_detail', message: job.title, jobUrl: job.url.split('?')[0] });
          const safeUrl = job.url.split('?')[0];

          try {
            await win.loadURL(safeUrl);
          } catch (err) {
            console.error('[❌ Load Error]', safeUrl, err.message);
            await sendHeartbeat({ status: 'job_load_failed', message: 'Failed to load job URL', jobUrl: safeUrl });
            continue;
          }

          const preScrapeMin = settings.jobDetailPreScrapeDelayMin || 2000;
          const preScrapeMax = settings.jobDetailPreScrapeDelayMax || 3000;

          await Promise.race([
            wait(preScrapeMin + Math.floor(Math.random() * (preScrapeMax - preScrapeMin))),
            solveCloudflareIfPresent(win, botId)
          ]);

          const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
          const htmlThreshold = settings.htmlLengthThreshold || 10000;

          if (htmlLengthCheck < htmlThreshold) {
            log(`[Warn] Job page may not be fully loaded. Waiting extra...`);
            await wait(settings.waitIfHtmlThresholdFailded || 1500);
          }

          await sendHeartbeat({ status: 'scraping_job', message: `Q${qi + 1} job ${i + 1}`, jobUrl: safeUrl });

          const details = await scrapeJobDetail(win, i, safeUrl);

          if (!details || !details.title || !details.description || details.description.length < 50) {
            log(`[Skip] No extractable content — title="${details?.title}" descLen=${details?.description?.length ?? 0}`);
            continue;
          }

          jobList[i] = { ...job, ...details };
          log(`[✅ Q${qi + 1} Job ${i + 1}]`, jobList[i].title);

          await sendHeartbeat({ status: 'saving_to_db', message: `Saving: ${jobList[i].title}`, jobUrl: safeUrl });
          await postJobToBackend(jobList[i]);
          totalScraped++;

          const minDelay = settings.delayBetweenJobsScrapingMin || 1000;
          const maxDelay = settings.delayBetweenJobsScrapingMax || 2000;
          await wait(minDelay + Math.floor(Math.random() * (maxDelay - minDelay)));
        }

        log(`[Query ${qi + 1} done] Moving to next query...`);
      }

      await sendHeartbeat({ status: 'cycle_complete', message: `Cycle complete — ${totalScraped} new jobs across ${queries.length} queries` });

      const minCycleDelay = settings.cycleDelayMin || 20000;
      const maxCycleDelay = settings.cycleDelayMax || 40000;

      const delay = minCycleDelay + Math.floor(Math.random() * (maxCycleDelay - minCycleDelay));
      log(`[Cycle] Waiting ${delay / 1000}s before next cycle...`);

      await sendHeartbeat({ status: 'idle', message: `Sleeping for ${delay / 1000}s before next cycle` });
      await wait(delay);


    } catch (err) {
      console.error('[❌ Cycle Error]', err.message);
      await sendHeartbeat({ status: 'cycle_error', message: err.message });
      await wait(15000);
    }
  }
}
