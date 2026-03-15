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

// ─── Phase 1: Event-driven page load ─────────────────────────────────────────
// Waits for the page to fully load (did-finish-load event) rather than sleeping
// a fixed number of ms. Falls back to `timeout` ms if the event never fires.
// Checks document.readyState first in case the page already loaded before we
// attached the listener (can happen on fast loads / cached pages).
async function waitForPageLoad(win, timeout = 8000) {
  try {
    const readyState = await win.webContents.executeJavaScript('document.readyState');
    if (readyState === 'complete') return;
  } catch { /* ignore — page context may not be ready yet */ }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

app.whenReady().then(async () => {
  settings = await getBotSettings(botId);
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
      // customQuery=true  → keyword mode: use searchQuery text field
      // customQuery=false → category mode: use searchQueries array (category2_uid URLs)
      const queries = settings.customQuery
        ? (settings.searchQuery?.trim() ? [settings.searchQuery.trim()] : [''])
        : (settings.searchQueries && settings.searchQueries.length > 0)
          ? settings.searchQueries
          : (settings.searchQuery?.trim() ? [settings.searchQuery.trim()] : ['']);

      log(`[🔍 Multi-Query] Running ${queries.length} search queries this cycle`);

      let totalScraped    = 0;
      let cycleDuplicates = 0;
      let cycleFeedFound  = 0;
      let cycleFiltered   = 0;
      let cycleLoadErrors = 0;

      for (let qi = 0; qi < queries.length; qi++) {
        const query = queries[qi].trim();

        log(`[Query ${qi + 1}/${queries.length}] "${query || '(all)'}"`);

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

        // ── Phase 1: event-driven feed load ───────────────────────────────────
        // Wait for the page to actually finish loading, then a short SPA hydration
        // grace period so Upwork's React app can populate the job list in the DOM.
        await waitForPageLoad(win, 10000);
        const feedWait = settings.waitAfterFeedPageLoad ?? 2000;
        if (feedWait > 0) await wait(feedWait);
        // ──────────────────────────────────────────────────────────────────────

        await solveCloudflareIfPresent(win, botId);

        await sendHeartbeat({ status: 'scraping_feed', message: `Extracting jobs for "${query || 'all'}"` });
        jobList = await scrapeJobFeed(win, botId);
        log(`🟡 Query "${query}" — found ${jobList.length} jobs`);
        cycleFeedFound += jobList.length;

        for (let i = 0; i < jobList.length; i++) {

          const job = jobList[i];

          // Skip any URL that is the feed page itself
          if (!job.url || job.url.split('?')[0].includes('/search/jobs/')) {
            log(`[Skip] Invalid or feed URL detected, skipping: ${job.url}`);
            continue;
          }

          const shouldVisit = await shouldVisitJob(job.url.split('?')[0]);
          if (!shouldVisit) {
            log(`[Skip] Already exists: ${job.url.split('?')[0]}`);
            cycleDuplicates++;
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
            cycleLoadErrors++;
            continue;
          }

          // ── Phase 1: event-driven job detail load ──────────────────────────
          // Replace fixed 2-3s random pre-scrape delay with actual page-load detection.
          // waitForPageLoad waits for did-finish-load (or readyState=complete).
          // The small grace period after covers any JS-rendered fields.
          await waitForPageLoad(win, 8000);
          await solveCloudflareIfPresent(win, botId);
          const gracePeriod = settings.jobDetailPreScrapeDelayMin ?? 500;
          if (gracePeriod > 0) await wait(gracePeriod);
          // ──────────────────────────────────────────────────────────────────

          const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
          const htmlThreshold = settings.htmlLengthThreshold || 10000;

          if (htmlLengthCheck < htmlThreshold) {
            log(`[Warn] Job page may not be fully loaded (${htmlLengthCheck} < ${htmlThreshold}). Waiting extra...`);
            await wait(settings.waitIfHtmlThresholdFailed || 1000);
          }

          await sendHeartbeat({ status: 'scraping_job', message: `Q${qi + 1} job ${i + 1}`, jobUrl: safeUrl });

          const details = await scrapeJobDetail(win, i, safeUrl);

          if (!details || !details.title || !details.description || details.description.length < 50) {
            log(`[Skip] No extractable content — title="${details?.title}" descLen=${details?.description?.length ?? 0}`);
            cycleFiltered++;
            continue;
          }

          jobList[i] = { ...job, ...details };
          log(`[✅ Q${qi + 1} Job ${i + 1}]`, jobList[i].title);

          await sendHeartbeat({ status: 'saving_to_db', message: `Saving: ${jobList[i].title}`, jobUrl: safeUrl });
          await postJobToBackend(jobList[i]);
          totalScraped++;

          // ── Phase 1: minimal fixed between-job delay ───────────────────────
          // No login = no per-job rate limit at the individual job level.
          // A small courtesy pause prevents hammering; natural page load time
          // (handled by waitForPageLoad above) already provides the main pacing.
          const betweenDelay = settings.delayBetweenJobsScrapingMin ?? 300;
          if (betweenDelay > 0) await wait(betweenDelay);
          // ──────────────────────────────────────────────────────────────────
        }

        log(`[Query ${qi + 1} done] Moving to next query...`);
      }

      await sendHeartbeat({
        status: 'cycle_complete',
        message: `Cycle complete — ${totalScraped} new | ${cycleDuplicates} dupes | ${cycleFeedFound} found`,
        statsInc: {
          cyclesCompleted:      1,
          feedPagesLoaded:      queries.length,
          feedJobsFound:        cycleFeedFound,
          duplicateJobsSkipped: cycleDuplicates,
          jobsFiltered:         cycleFiltered,
          jobLoadErrors:        cycleLoadErrors,
        },
        statsSet: {
          lastCycleJobsScraped: totalScraped,
          lastCycleDuplicates:  cycleDuplicates,
          lastCycleFeedFound:   cycleFeedFound,
          lastCycleFiltered:    cycleFiltered,
        }
      });

      // ── Phase 1: adaptive cycle delay ─────────────────────────────────────
      // If the entire cycle yielded zero new jobs (all dupes), the feed hasn't
      // refreshed — waiting the normal 10-20s before hammering it again is pointless.
      // Instead, wait `staleCycleDelayMs` (default 5 min) to give the feed time to
      // accumulate fresh postings.
      // If new jobs were found, use the normal short cycleDelay so we catch the
      // next batch quickly.
      const newJobRatio = cycleFeedFound > 0 ? totalScraped / cycleFeedFound : 0;
      const isStale     = totalScraped === 0 && cycleFeedFound > 0;

      let delay;
      if (isStale) {
        delay = settings.staleCycleDelayMs ?? 300000; // 5 minutes
        log(`[Cycle] Feed stale (0/${cycleFeedFound} new) — sleeping ${(delay / 1000 / 60).toFixed(1)} min before retry`);
      } else {
        const minDelay = settings.cycleDelayMin ?? 10000;
        const maxDelay = settings.cycleDelayMax ?? 20000;
        delay = minDelay + Math.floor(Math.random() * Math.max(0, maxDelay - minDelay));
        log(`[Cycle] ${totalScraped} new jobs — sleeping ${(delay / 1000).toFixed(1)}s before next cycle`);
      }
      // ──────────────────────────────────────────────────────────────────────

      await sendHeartbeat({ status: 'idle', message: `Sleeping for ${(delay / 1000).toFixed(1)}s before next cycle` });
      await wait(delay);


    } catch (err) {
      console.error('[❌ Cycle Error]', err.message);
      await sendHeartbeat({ status: 'cycle_error', message: err.message });
      await wait(15000);
    }
  }
}
