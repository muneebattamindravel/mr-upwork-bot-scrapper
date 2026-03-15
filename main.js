require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const { app, session, screen } = require('electron');
const { createBrowserWindow, createBrowserWindowNoLogin } = require('./modules/browser');
const { solveCloudflareIfPresent } = require('./modules/cloudflareSolver');
const { scrapeJobFeed } = require('./modules/feedScraper');
const { scrapeJobDetail } = require('./modules/detailScraper');
const { sendHeartbeat, startHeartbeatInterval } = require('./modules/heartbeat');
const { /*isLoginPage,*/ shouldVisitJob, postJobToBackend, wait, log } = require('./modules/utils');
const { getBotSettings } = require('./modules/botSettings');

// Ensure feed-dumps directory exists at startup
const FEED_DUMP_DIR = path.join(__dirname, 'feed-dumps');
if (!fs.existsSync(FEED_DUMP_DIR)) fs.mkdirSync(FEED_DUMP_DIR);

const botId = process.env.BOT_ID || 'bot-001';

let win;
let settings;
let jobList = [];
let cycleCount = 0; // incremented at the start of each cycle — shown in dashboard as "Cycle #N"

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

// ─── Wait for Upwork SPA to render job cards ─────────────────────────────────
// did-finish-load fires when the JS bundle loads, but Upwork's React app then
// makes an API call to fetch jobs and renders the cards asynchronously.
// This polls the DOM every 500ms until actual job links (/jobs/~...) appear,
// or gives up after `timeout` ms. Fixes missed jobs due to SPA hydration lag.
async function waitForJobLinks(win, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      // Upwork job URLs: /jobs/Title_~ID or /jobs/~ID — always contain ~ but
      // never directly after /jobs/ in slug form. Use /jobs/ + ~ filter.
      const count = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('a[href*="/jobs/"]'))
           .filter(a => { const p = a.href.split('?')[0]; return p.includes('~') && !p.includes('/nx/'); }).length`
      );
      if (count > 0) {
        log(`[Feed] Job links appeared in DOM (${count} found)`);
        return count;
      }
    } catch { /* page context not ready yet */ }
    await wait(500);
  }
  log(`[Feed] Timeout waiting for job links — scraping whatever is in DOM`);
  return 0;
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
      cycleCount++;

      settings = await getBotSettings(botId);
      const queryNames = settings.searchQueryNames || [];

      await sendHeartbeat({ status: 'navigating_feed', message: `Starting cycle #${cycleCount}` });

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
        // keyword mode: the query IS the name; category mode: use the parallel name array
        const queryName = settings.customQuery
          ? (query || 'All Jobs')
          : (queryNames[qi] || `Category ${qi + 1}`);

        log(`[Query ${qi + 1}/${queries.length}] "${queryName}" — ${query || '(all)'}`);

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

        await sendHeartbeat({
          status: 'navigating_feed',
          message: `Loading ${queryName}`,
          progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: 0, jobTotal: 0 },
        });
        await win.loadURL(url);

        // ── Phase 1: event-driven feed load ───────────────────────────────────
        // Order matters:
        // 1. waitForPageLoad — JS bundle finished loading
        // 2. solveCloudflareIfPresent — if CF challenge page, solve it first.
        //    CF solver waits cloudflareWaitAfterClick (5s) then re-checks.
        //    After it returns, the real Upwork page is loading.
        // 3. waitForJobLinks — poll until React renders job cards. This covers
        //    both normal load and post-CF load in one step.
        // 4. Grace period fallback — only if waitForJobLinks timed out entirely
        //    (e.g. CF couldn't be solved, or page returned no results).
        await waitForPageLoad(win, 10000);
        await solveCloudflareIfPresent(win, botId, 0, { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: 0, jobTotal: 0 });
        const domReady = await waitForJobLinks(win, 15000);
        if (!domReady) {
          const feedWait = settings.waitAfterFeedPageLoad ?? 2000;
          if (feedWait > 0) await wait(feedWait);
        }
        // ──────────────────────────────────────────────────────────────────────

        // Save feed page HTML dump for debugging (non-blocking).
        // Files saved to: mr-upwork-bot-scrapper/feed-dumps/feed_dump_qi<N>_<timestamp>.html
        try {
          const feedHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
          const dumpName = `feed_dump_q${qi + 1}_${Date.now()}.html`;
          fs.promises.writeFile(path.join(FEED_DUMP_DIR, dumpName), feedHtml, 'utf-8')
            .then(() => log(`[FeedDump] Saved: ${dumpName}`))
            .catch(e => log('[FeedDump] Write failed:', e.message));
        } catch (e) {
          log('[FeedDump] Capture failed:', e.message);
        }

        await sendHeartbeat({
          status: 'scraping_feed',
          message: `Scanning feed — ${queryName}`,
          progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: 0, jobTotal: 0 },
        });
        jobList = await scrapeJobFeed(win, botId);
        log(`🟡 "${queryName}" — found ${jobList.length} jobs`);
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

          await sendHeartbeat({
            status: 'visiting_job_detail',
            message: job.title,
            jobUrl: job.url.split('?')[0],
            progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: i + 1, jobTotal: jobList.length },
          });
          const safeUrl = job.url.split('?')[0];

          try {
            await win.loadURL(safeUrl);
          } catch (err) {
            console.error('[❌ Load Error]', safeUrl, err.message);
            await sendHeartbeat({
            status: 'job_load_failed',
            message: 'Failed to load job page',
            jobUrl: safeUrl,
            progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: i + 1, jobTotal: jobList.length },
          });
            cycleLoadErrors++;
            continue;
          }

          // ── Phase 1: event-driven job detail load ──────────────────────────
          // Replace fixed 2-3s random pre-scrape delay with actual page-load detection.
          // waitForPageLoad waits for did-finish-load (or readyState=complete).
          // The small grace period after covers any JS-rendered fields.
          await waitForPageLoad(win, 8000);
          await solveCloudflareIfPresent(win, botId, 0, { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: i + 1, jobTotal: jobList.length });
          const gracePeriod = settings.jobDetailPreScrapeDelayMin ?? 500;
          if (gracePeriod > 0) await wait(gracePeriod);
          // ──────────────────────────────────────────────────────────────────

          const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
          const htmlThreshold = settings.htmlLengthThreshold || 10000;

          if (htmlLengthCheck < htmlThreshold) {
            log(`[Warn] Job page may not be fully loaded (${htmlLengthCheck} < ${htmlThreshold}). Waiting extra...`);
            await wait(settings.waitIfHtmlThresholdFailed || 1000);
          }

          await sendHeartbeat({
            status: 'scraping_job',
            message: job.title,
            jobUrl: safeUrl,
            progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: i + 1, jobTotal: jobList.length },
          });

          const details = await scrapeJobDetail(win, i, safeUrl);

          if (!details || !details.title || !details.description || details.description.length < 50) {
            log(`[Skip] No extractable content — title="${details?.title}" descLen=${details?.description?.length ?? 0}`);
            cycleFiltered++;
            continue;
          }

          jobList[i] = { ...job, ...details };
          log(`[✅ Q${qi + 1} Job ${i + 1}]`, jobList[i].title);

          await sendHeartbeat({
            status: 'saving_to_db',
            message: `Saving: ${jobList[i].title}`,
            jobUrl: safeUrl,
            progress: { queryIndex: qi + 1, queryTotal: queries.length, queryName, jobIndex: i + 1, jobTotal: jobList.length },
          });
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
        message: `Cycle #${cycleCount} done — ${totalScraped} new · ${cycleDuplicates} dupes · ${cycleFeedFound} found`,
        progress: { queryIndex: 0, queryTotal: queries.length, queryName: '', jobIndex: 0, jobTotal: 0 },
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
      const isStale = totalScraped === 0 && cycleFeedFound > 0;

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
