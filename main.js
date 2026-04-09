require('dotenv').config();
// v2.1.0 — mkProg progress in all heartbeats including CF solver; {name,url} query objects
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

// Ensure dump directories exist at startup
const FEED_DUMP_DIR    = path.join(__dirname, 'feed-dumps');
const SKIPPED_DUMP_DIR = path.join(__dirname, 'skipped-dumps');
if (!fs.existsSync(FEED_DUMP_DIR))    fs.mkdirSync(FEED_DUMP_DIR);
if (!fs.existsSync(SKIPPED_DUMP_DIR)) fs.mkdirSync(SKIPPED_DUMP_DIR);

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

// ─── Wait for Upwork SPA to render job description ───────────────────────────
// For detail pages: did-finish-load fires when the JS bundle loads, but Vue.js
// then makes an API call to fetch the job and renders description asynchronously.
// Poll every 400ms until data-test="Description" has visible text (> 20 chars),
// or give up after `timeout` ms. This prevents blank descriptions from pages
// captured mid-render (was the #1 cause of empty description field in DB).
async function waitForJobDescription(win, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const len = await win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('[data-test="Description"]');
          return el ? (el.innerText || '').trim().length : 0;
        })()
      `);
      if (len > 20) {
        log(`[Detail] Description rendered in DOM (${len} chars)`);
        return true;
      }
    } catch { /* page context not ready yet */ }
    await wait(400);
  }
  log(`[Detail] Timeout waiting for description — scraping whatever is in DOM`);
  return false;
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

      await sendHeartbeat({ status: 'navigating_feed', message: `Starting cycle #${cycleCount}` });

      const maxJobs = settings.perPage || 50;

      // IMP S7: multi-query sweep — run ALL queries in one cycle for full tech coverage.
      // settings.searchQueries entries are either {name, url} objects (new) or plain URL strings (old).
      // Keyword mode (customQuery=true) builds a single synthetic {name, url} from searchQuery text.
      let queries; // always an array of {name: String, url: String}
      if (settings.customQuery) {
        const q = settings.searchQuery?.trim() || '';
        queries = [{ name: q || 'All Jobs', url: q }];
      } else {
        const raw = (settings.searchQueries && settings.searchQueries.length > 0)
          ? settings.searchQueries
          : (settings.searchQuery?.trim() ? [settings.searchQuery.trim()] : []);
        const legacyNames = settings.searchQueryNames || [];
        queries = raw.map((q, i) =>
          typeof q === 'string'
            ? { name: legacyNames[i] || `Category ${i + 1}`, url: q }
            : { name: q.name || `Category ${i + 1}`, url: q.url || '' }
        );
      }

      log(`[🔍 Multi-Query] Running ${queries.length} search queries this cycle`);

      let totalScraped    = 0;
      let cycleDuplicates = 0;
      let cycleFeedFound  = 0;
      let cycleFiltered   = 0;
      let cycleLoadErrors = 0;
      let lastQueryName   = '';   // persisted to cycle_complete so dashboard shows last category name

      for (let qi = 0; qi < queries.length; qi++) {
        const queryItem = queries[qi];             // {name, url}
        const queryName = queryItem.name || `Category ${qi + 1}`;
        const query     = queryItem.url  || '';
        lastQueryName   = queryName;              // track so cycle_complete can reference it

        log(`[Query ${qi + 1}/${queries.length}] "${queryName}" — ${query || '(all)'}`);

        // ── Progress helper — builds the full progress payload including live running totals.
        // Defined inside the qi loop so queryName is always the current category.
        // The counter variables (cycleFeedFound etc.) are captured by reference, so calling
        // mkProg() always reflects their current values at the time of the call.
        const mkProg = (jIdx, jTotal) => ({
          queryIndex: qi + 1,
          queryTotal: queries.length,
          queryName,
          jobIndex:  jIdx,
          jobTotal:  jTotal,
          found:     cycleFeedFound,
          newJobs:   totalScraped,
          dupes:     cycleDuplicates,
          filtered:  cycleFiltered,
        });

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
          progress: mkProg(0, 0),
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
        await solveCloudflareIfPresent(win, botId, 0, mkProg(0, 0));
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
          progress: mkProg(0, 0),
        });

        // ── Paginated feed scraping ─────────────────────────────────────────────
        // Upwork caps unauthenticated feed at 10 jobs per page regardless of
        // per_page param. To honour maxJobs (e.g. 30), we load pages 2, 3, …
        // using paging_offset until we have enough unique links or run out of results.
        const UPWORK_PAGE_CAP = 10; // server-side cap for unauthenticated users
        const pagesNeeded = Math.ceil(maxJobs / UPWORK_PAGE_CAP);

        jobList = await scrapeJobFeed(win, botId);
        log(`🟡 "${queryName}" — page 1: ${jobList.length} jobs`);

        for (let pg = 2; pg <= pagesNeeded && jobList.length < maxJobs; pg++) {
          const pageUrl = new URL(url);
          pageUrl.searchParams.set('paging_offset', String((pg - 1) * UPWORK_PAGE_CAP));
          pageUrl.searchParams.set('per_page', '10');

          await sendHeartbeat({
            status: 'scraping_feed',
            message: `Scanning feed — ${queryName} (page ${pg}/${pagesNeeded})`,
            progress: mkProg(0, 0),
          });

          await win.loadURL(pageUrl.toString());
          await waitForPageLoad(win, 10000);
          await solveCloudflareIfPresent(win, botId, 0, mkProg(0, 0));
          const pgReady = await waitForJobLinks(win, 15000);
          if (!pgReady) {
            log(`[Feed] Page ${pg} didn't load — stopping pagination`);
            break;
          }

          // Extract links directly (same logic as feedScraper.js)
          const existingUrls = new Set(jobList.map(j => j.url));
          const pageJobs = await win.webContents.executeJavaScript(`
            Array.from(document.querySelectorAll('a[href*="/jobs/"]'))
              .filter(a => {
                const p = a.href.split('?')[0];
                return p.includes('~') && !p.includes('/nx/') && a.innerText.trim().length > 10;
              })
              .map(a => ({ title: a.innerText.trim(), url: a.href.split('?')[0] }));
          `);

          const newLinks = (pageJobs || []).filter(j => !existingUrls.has(j.url));
          log(`[Feed] "${queryName}" page ${pg}: ${pageJobs.length} found, ${newLinks.length} new`);
          if (newLinks.length === 0) break; // end of results
          jobList = [...jobList, ...newLinks];
        }

        jobList = jobList.slice(0, maxJobs); // final cap
        log(`🟡 "${queryName}" — total after pagination: ${jobList.length} jobs`);
        // ──────────────────────────────────────────────────────────────────────

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
            // Send heartbeat so job counter advances on dashboard — without this,
            // dupe-skipped jobs are invisible and the counter appears frozen.
            await sendHeartbeat({
              status: 'visiting_job_detail',
              message: `Duplicate — skipping`,
              jobUrl: job.url.split('?')[0],
              progress: mkProg(i + 1, jobList.length),
            });
            await wait(300);
            continue;
          }

          await sendHeartbeat({
            status: 'visiting_job_detail',
            message: job.title,
            jobUrl: job.url.split('?')[0],
            progress: mkProg(i + 1, jobList.length),
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
              progress: mkProg(i + 1, jobList.length),
            });
            cycleLoadErrors++;
            continue;
          }

          // ── Phase 1: event-driven job detail load ──────────────────────────
          // waitForPageLoad — JS bundle finished loading
          // solveCloudflareIfPresent — handle CF challenge if shown
          // waitForJobDescription — poll until Vue.js renders the description
          //   text into data-test="Description" (replaces fixed grace period).
          //   This is the key fix for blank descriptions: did-finish-load fires
          //   when the bundle loads, but the description API call + render takes
          //   longer on some pages. Polling ensures we always capture real content.
          await waitForPageLoad(win, 8000);
          await solveCloudflareIfPresent(win, botId, 0, mkProg(i + 1, jobList.length));
          await waitForJobDescription(win, 12000);
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
            progress: mkProg(i + 1, jobList.length),
          });

          const details = await scrapeJobDetail(win, i, safeUrl);

          if (!details || !details.title) {
            const reason = !details ? 'scraper-null' : 'no-title';
            log(`[Skip] No extractable content — ${reason} — url=${safeUrl}`);

            // Save HTML dump to skipped-dumps/ for post-analysis
            try {
              const skippedHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
              const urlSlug = safeUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-60);
              const dumpName = `skipped_${Date.now()}_${reason}_${urlSlug}.html`;
              fs.promises.writeFile(path.join(SKIPPED_DUMP_DIR, dumpName), skippedHtml, 'utf-8')
                .then(() => log(`[SkippedDump] Saved: ${dumpName}`))
                .catch(e => log('[SkippedDump] Write failed:', e.message));
            } catch (e) {
              log('[SkippedDump] Capture failed:', e.message);
            }

            await sendHeartbeat({
              status: 'job_filtered',
              message: `Filtered: ${reason}`,
              jobUrl: safeUrl,
              progress: mkProg(i + 1, jobList.length),
            });
            cycleFiltered++;
            continue;
          }

          // mainCategory = top-level Upwork cluster (e.g. "Web, Mobile & Software Dev")
          // jobCategory  = specific category parsed from the job's own detail page
          jobList[i] = { ...job, ...details, mainCategory: queryName };
          log(`[✅ Q${qi + 1} Job ${i + 1}]`, jobList[i].title);

          await sendHeartbeat({
            status: 'saving_to_db',
            message: `Saving: ${jobList[i].title}`,
            jobUrl: safeUrl,
            progress: mkProg(i + 1, jobList.length),
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
        // Keep lastQueryName so dashboard still shows category name during idle/between cycles
        progress: { queryIndex: queries.length, queryTotal: queries.length, queryName: lastQueryName, jobIndex: 0, jobTotal: 0, found: cycleFeedFound, newJobs: totalScraped, dupes: cycleDuplicates, filtered: cycleFiltered },
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
