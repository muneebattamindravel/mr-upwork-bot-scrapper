# Scraper — Claude Context

> Full project context (all repos, fix history, architecture decisions) is in the root CLAUDE.md:
> @../CLAUDE.md
>
> This file covers Scraper-specific quick reference only.

---

## What This Repo Is

Electron-based Upwork scraper running on a **Windows EC2** instance. Navigates Upwork job feeds without login, extracts job data, and sends it to the Brain API.

- `agent.js` — Express server on port 4001, always running (keep-alive + start/stop listener)
- `main.js` — Electron scraper, launched by agent on Dashboard "Start" command

---

## Quick Commands

```bash
node agent.js       # start the agent (do this first, always)
npm test            # run electron directly (for testing only)
```

---

## Key Files — Open These First

| File | Why |
|------|-----|
| `main.js` | Full scrape cycle — `loadURLWithTimeout`, `waitForJobDescription`, multi-query loop |
| `agent.js` | Agent server — register, keep-alive, start/stop via socket + HTTP polling |
| `modules/detailScraper.js` | Job data extraction — all field patterns, fallbacks, HTML dump on failure |
| `modules/cloudflareSolver.js` | AHK integration — depth guard (max 3 retries) |
| `modules/heartbeat.js` | Status strings sent to Brain |
| `.env` | `BOT_ID` + `BRAIN_BASE_URL` |

---

## Scrape Cycle (simplified)

```
agent starts → registers with Brain → keep-alive every 30s
Dashboard "Start" → agent launches Electron (main.js)
  ↓
For each searchQuery URL:
  loadURLWithTimeout(35s) → solve Cloudflare if needed
  feedScraper → job URLs
  For each new URL (shouldVisit check):
    loadURLWithTimeout(35s) → waitForJobDescription(12s)
    detailScraper → job fields
    POST /jobs/ingest to Brain
cycle_complete → wait cycleDelay → repeat
```

---

## Constraints — Never Break These

- **Data shape to Brain is frozen** — these exact field names, no additions/removals without coordinating Brain: `title, url, description, mainCategory, jobCategory, experienceLevel, projectType, postedDate, requiredConnects, clientCountry, clientCity, clientSpend, clientJobsPosted, clientHires, clientHireRate, clientMemberSince, clientPaymentVerified, clientPhoneVerified, clientAverageHourlyRate, clientRating, clientReviews, pricingModel, minRange, maxRange`
- **Heartbeat status strings are frozen** — Dashboard monitors exactly these strings; don't rename: `navigating_feed, scraping_feed, visiting_job_detail, scraping_job, saving_to_db, cycle_complete, idle, cloudflare_detected, cloudflare_passed, job_load_failed`
- **agent.js endpoints are frozen** — Dashboard calls `/start-bot`, `/stop-bot`, `/status` on port 4001
- **Keep `loadURLWithTimeout`** — never call `win.loadURL()` directly; it has no timeout and will hang
- **Keep `waitForJobDescription`** — never revert to fixed waits; Upwork's Vue.js renders description async
- **Keep AHK** — `click.ahk` is still required; no DOM-based CF solver yet (Phase 2 plan)

---

## Common Patterns

### Navigation (always use timeout wrapper)
```js
await loadURLWithTimeout(win, url, 35000);
```

### Waiting for page content
```js
await waitForJobDescription(win, 12000);  // polls every 400ms
```

### Sending heartbeat
```js
await sendHeartbeat({ status: 'visiting_job_detail', message: `Job ${i}/${total}`, jobsScraped: i });
```

### Skipping a job URL
```js
const should = await shouldVisitJob(url);
if (!should) { /* send heartbeat with skip reason, continue */ }
```

---

## Debugging Failed Extractions

When `detailScraper` fails to extract a job, it saves the raw HTML to:
```
skipped-dumps/skipped_<timestamp>_<reason>_<url-slug>.html
```

Run `debug-patterns.js` against these dumps to test extraction pattern changes without a live browser.

---

## AHK Notes

- `click.ahk` clicks at **x=463, y=225** — fixed screen coordinates for the Cloudflare checkbox
- If the checkbox appears at a different position, edit those coordinates in `click.ahk`
- AHK must be installed on the Windows machine (`AutoHotkey v1`, not v2)
- The AHK binary is invoked via `child_process.exec('AutoHotkey.exe click.ahk', { shell: true })`

---

## Bot Settings (fetched from Brain each cycle)

The scraper does NOT have hardcoded settings — it fetches everything from Brain on each cycle:
```
GET /up-bot-brain-api/bots/settings/:botId
```

Change search queries, delays, job limits, etc. from the Dashboard → Settings → Scraper Configs. Changes take effect on the next cycle start (no restart needed).

---

## Detailed Docs

- @README.md — Full module reference, deployment on EC2, troubleshooting table, data contract
