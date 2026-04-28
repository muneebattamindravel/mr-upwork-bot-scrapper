# mr-upwork-bot-scrapper

Electron-based Upwork job scraper for Mindravel Interactive. Runs on a Windows EC2 instance, navigates Upwork search feeds without logging in, extracts job details, and forwards them to the Brain API.

---

## Prerequisites

- **Windows** (EC2 or any Windows machine)
- **Node.js** v18+
- **AutoHotkey v1** — required for Cloudflare checkbox automation. Download from [autohotkey.com](https://www.autohotkey.com)
- Brain server running and reachable

---

## Installation

```bash
# Clone the repo
git clone <repo-url>
cd mr-upwork-bot-scrapper

# Install dependencies
npm install

# Configure environment
copy .env.example .env
# Edit .env with your values (see below)
```

---

## Environment Variables

```env
# Unique identifier for this bot instance (used in all heartbeats + DB records)
BOT_ID=ec2-t2micro-scraper-bot

# Base URL of the Brain API (no trailing slash, no /up-bot-brain-api suffix)
BRAIN_BASE_URL=https://your-brain-server.com
```

---

## Running

The scraper has two processes that run together:

### 1. Agent (always runs first)

```bash
node agent.js
```

The agent is an Express server on port `4001`. It:
- Registers the bot with Brain on startup
- Starts keep-alive pings to Brain every 30 seconds (`/bots/agent-heartbeat`)
- Listens for start/stop commands from the Dashboard (via Socket.IO or HTTP polling)
- Launches `main.js` (the Electron scraper) on start command

### 2. Scraper (launched by agent)

The Electron scraper (`main.js`) starts automatically when the Dashboard issues a **Start** command. You can also run it directly for testing:

```bash
npm test   # runs: electron .
```

---

## How a Scrape Cycle Works

```
agent.js starts → registers with Brain → keep-alive every 30s
      │
      │ Dashboard sends Start command
      ▼
main.js (Electron) launches
      │
      ├─ 1. Fetch bot settings from Brain (/bots/settings/:botId)
      │     (searchQueries, maxJobsPerCycle, delays, thresholds, ...)
      │
      ├─ 2. For each search query URL:
      │     ├─ loadURL with 35s timeout
      │     ├─ Solve Cloudflare if detected (AHK click)
      │     ├─ Extract job links from feed (feedScraper)
      │     └─ Filter: skip already-seen URLs (/jobs/shouldVisit)
      │
      ├─ 3. For each new job URL (up to maxJobsPerCycle):
      │     ├─ loadURL with 35s timeout
      │     ├─ Poll DOM for description (up to 12s wait)
      │     ├─ Extract all job fields (detailScraper)
      │     ├─ Save HTML dump if extraction fails (skipped-dumps/)
      │     └─ POST job to Brain (/jobs/ingest)
      │
      ├─ 4. Send cycle_complete heartbeat
      └─ 5. Wait cycleDelay (adaptive), then repeat
```

---

## File Structure

```
mr-upwork-bot-scrapper/
├── agent.js                # Express server (port 4001) — receives start/stop, keep-alive
├── main.js                 # Electron entry point — the full scrape cycle loop
├── preload.js              # Electron preload (contextBridge)
├── click.ahk               # AutoHotkey script — clicks Cloudflare checkbox at x=463, y=225
├── start-bot.bat           # Windows batch file to launch agent.js easily
├── .env                    # BOT_ID, BRAIN_BASE_URL
└── modules/
    ├── browser.js          # Creates BrowserWindow (no-login mode)
    ├── feedScraper.js      # Extracts job links from Upwork search results page
    ├── detailScraper.js    # Extracts full job data from each job detail page
    ├── cloudflareSolver.js # Detects Cloudflare challenge, triggers AHK click
    ├── botSettings.js      # Fetches bot config from Brain API
    ├── heartbeat.js        # Sends status heartbeats to Brain
    └── utils.js            # wait(), log(), isLoginPage(), postJobToBackend(), shouldVisitJob()
```

---

## Module Reference

### `agent.js`
Express server on port **4001**. Manages the bot lifecycle.

**Endpoints exposed (called by Dashboard or Brain):**
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/start-bot` | Launch Electron scraper (queues command) |
| `POST` | `/stop-bot` | Kill Electron scraper process |
| `GET` | `/status` | Returns `{ running: bool }` |

**Key behaviours:**
- On startup: calls `POST /bots/register` on Brain
- Calls `startAgentKeepAlive()` → pings `POST /bots/agent-heartbeat` every 30s
- Connects to Brain via Socket.IO; listens for `bot:command` events (instant start/stop)
- Falls back to HTTP polling `GET /bots/poll-command/:botId` every 5s when socket is disconnected

---

### `main.js`
The Electron main process. Runs the full scrape cycle in a loop.

**Key functions:**
- `loadURLWithTimeout(win, url, timeout=35000)` — wraps `win.loadURL()` in a `Promise.race()` against a 35-second timer; prevents navigation from hanging forever
- `waitForJobDescription(win, timeout=12000)` — polls the DOM every 400ms until `data-test="Description"` has > 20 characters; handles Upwork's Vue.js hydration lag
- `qi(queryUrl, queryName, win)` — scrapes one full search query (feed → job details)
- Main loop: fetches settings, iterates all `searchQueries`, waits `cycleDelay`, repeats

**Heartbeat statuses sent:**
| Status | Meaning |
|--------|---------|
| `navigating_feed` | Loading a search results page |
| `scraping_feed` | Extracting job links from feed |
| `visiting_job_detail` | Loading a job detail page |
| `scraping_job` | Extracting data from job page |
| `saving_to_db` | Posting job to Brain |
| `cycle_complete` | Full cycle finished, entering idle wait |
| `idle` | Waiting between cycles |
| `cloudflare_detected` | Cloudflare challenge on screen |
| `cloudflare_passed` | Cloudflare solved successfully |
| `job_load_failed` | Page load timed out or failed |

---

### `modules/browser.js`
Creates the Electron `BrowserWindow` in **no-login mode** (no cookies, no stored session).

- `createBrowserWindowNoLogin()` — standard window, no stored cookies
- `createBrowserWindow()` — legacy login mode (loads `upwork_cookies.json`); not used in current setup

---

### `modules/feedScraper.js`
Extracts job URLs from the Upwork search results page.

- Selects all `a[href*="/jobs/"]` anchors from the page DOM
- Filters out pagination/navigation links (skips any URL containing `/search/jobs/`)
- Returns an array of absolute job URLs

---

### `modules/detailScraper.js`
Extracts all job fields from a loaded job detail page.

**Fields extracted (no-login format):**

| Field | Source |
|-------|--------|
| `title` | `<title>` tag — `"Job Title - Freelance Job in Category - Upwork"` or `"Job Title \| Upwork"` format |
| `jobCategory` | `<title>` tag — sub-category portion |
| `mainCategory` | Passed in from `queryName` (the search query name) |
| `description` | `data-test="Description"` → `.multiline-text`; strips `"Summary "` prefix |
| `experienceLevel` | `data-cy="expertise"` → `.description` |
| `projectType` | `<strong>One-time project</strong>` or `<strong>Ongoing project</strong>` |
| `pricingModel` | `data-cy="fixed-price"` or `data-cy="clock-hourly"` |
| `budget` / `minRange` / `maxRange` | `BudgetAmount` keyword + multiple fallbacks |
| `postedDate` | `time[datetime]` attribute near posted label |
| `clientCountry` / `clientCity` | `data-qa="client-location"` |
| `clientSpend` | `data-qa="client-spend"` → first `<span>` |
| `clientHires` | `data-qa="client-hires"` → `"N hires"` pattern |
| `clientMemberSince` | `"Member since"` text node |

**Not available without login (always returns default):**
`requiredConnects`, `clientPaymentVerified`, `clientPhoneVerified`, `clientAverageHourlyRate`, `clientJobsPosted`, `clientHireRate`, `clientRating`, `clientReviews`

On extraction failure: saves HTML to `skipped-dumps/skipped_<timestamp>_<reason>_<url-slug>.html` for debugging.

---

### `modules/cloudflareSolver.js`
Detects and solves Cloudflare "I'm not a robot" challenges.

- Detects via page title containing `"Just a moment"` or presence of Cloudflare iframe
- Triggers `click.ahk` via `child_process.exec` — clicks at screen coordinates `x=463, y=225`
- Waits `cloudflareWaitAfter` ms for Cloudflare to resolve
- Max 3 recursive retries (`depth` param); gives up with `cloudflare_failed` heartbeat after 3 attempts

> **Note:** AHK coordinates are fixed (x=463, y=225). If the Cloudflare checkbox appears at a different position on your screen, edit `click.ahk`.

---

### `modules/botSettings.js`
Fetches the bot's operational configuration from Brain on each cycle start.

```js
// Fields returned by Brain (bot.settings):
{
  searchQueries: ['https://...', 'https://...'],  // URLs to scrape
  maxJobsPerCycle: 50,
  perPage: 10,
  feedWait: 3000,
  heartbeatInterval: 10000,
  jobDetailPreScrapeDelayMin: 1000,
  jobDetailPreScrapeDelayMax: 3000,
  delayBetweenJobsScrapingMin: 500,
  delayBetweenJobsScrapingMax: 1500,
  cycleDelayMin: 60000,
  cycleDelayMax: 120000,
  htmlLengthThreshold: 5000,
  waitIfHtmlThresholdFailed: 5000,
  cloudflareWaitBeforeClick: 3000,
  cloudflareWaitAfter: 5000,
}
```

---

### `modules/heartbeat.js`
Sends status updates to Brain every `heartbeatInterval` ms and on key status changes.

```
POST /up-bot-brain-api/bots/heartbeat
{
  botId: "...",
  status: "scraping_job",
  message: "Processing job 3/50",
  jobsScraped: 3,
  jobsSkipped: 7,
  totalJobsSeen: 10
}
```

---

### `modules/utils.js`

| Function | Description |
|----------|-------------|
| `wait(ms)` | Promise-based sleep |
| `log(msg)` | Timestamped console output |
| `isLoginPage(win)` | Checks if current page is Upwork login (legacy, not used in no-login mode) |
| `postJobToBackend(jobData)` | POSTs to `/jobs/ingest` with retry on network error |
| `shouldVisitJob(url)` | Checks `/jobs/shouldVisit` — returns `true` if URL is new |

---

## Bot Settings — Configuring Search Queries

Search queries are configured in the Dashboard under **Settings → Scraper Configs**. Each entry has:
- **Name** — used as `queryName` (stored as `mainCategory` on each job)
- **URL** — Upwork search URL (can include filters like `location_type=worldwide`, `category2_uid=...`)

The scraper fetches these from Brain on each cycle start, so changes take effect on the next cycle without restarting.

---

## Deployment on Windows EC2

### First-time setup
```bash
# 1. Install Node.js (LTS) and AutoHotkey v1 on the EC2 instance
# 2. Clone the repo
# 3. npm install
# 4. Edit .env
# 5. Start the agent
node agent.js
# OR double-click start-bot.bat
```

### Keeping agent alive (pm2 on Windows)
```bash
npm install -g pm2
pm2 start agent.js --name upwork-agent
pm2 save
pm2 startup
```

### Starting the scraper
Once the agent is running, use the Dashboard's **Scraper Monitor** page to start/stop the scraper remotely.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Scraper freezes after 2-3 hours | Page load timed out (no timeout guard) | Already fixed via `loadURLWithTimeout()` — update to latest |
| Blank descriptions on many jobs | Vue.js hydration lag | Already fixed via `waitForJobDescription()` |
| Cloudflare never solves | AHK coordinates wrong | Edit `click.ahk` x/y coordinates to match your screen |
| Agent shows offline in dashboard | Keep-alive not reaching Brain | Check `BRAIN_BASE_URL` in `.env`, check network/firewall |
| `job_load_failed` heartbeats | Upwork blocking EC2 IP | Consider residential proxy (see Scraper Configs settings) |

---

## Data Contract with Brain

The scraper sends this exact shape to `POST /jobs/ingest`. **Do not change field names** without coordinating with Brain.

```js
{
  botId, url, title, description,
  mainCategory,          // = queryName (the search category name)
  jobCategory,           // = specific sub-category from <title> tag
  experienceLevel, projectType, postedDate,
  pricingModel, minRange, maxRange,
  requiredConnects,
  clientCountry, clientCity, clientSpend, clientJobsPosted,
  clientHires, clientHireRate, clientMemberSince,
  clientPaymentVerified, clientPhoneVerified,
  clientAverageHourlyRate, clientRating, clientReviews,
}
```
