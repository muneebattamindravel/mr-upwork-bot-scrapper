const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

require('dotenv').config();
console.log('[BOOT] BOT_ID =', process.env.BOT_ID);

let win;
let jobList = [];

let currentStatus = 'booting';
let currentMessage = '';
let currentJobUrl = '';

async function isLoginPage(win) {
  const currentURL = win.webContents.getURL();
  return currentURL.includes('/login') || currentURL.includes('account-security');
}

app.whenReady().then(async () => {

  setInterval(() => {
    sendHeartbeat({
      status: currentStatus,
      message: currentMessage,
      jobUrl: currentJobUrl
    });
  }, 10000);

  const ses = session.defaultSession;
  //mun
  // Load cookies
  const cookiePath = path.join(__dirname, 'upwork_cookies.json');
  const fileContent = fs.readFileSync(cookiePath, 'utf-8').replace(/^\uFEFF/, '');
  const cookies = JSON.parse(fileContent);

  for (const c of cookies) {
    await ses.cookies.set({
      url: 'https://www.upwork.com',
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || 'Lax',
      expirationDate: c.expirationDate
    });
  }

  console.log('[Debug] Cookies injected. 1');

  // Get screen dimensions
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    x: 0, // Left aligned
    y: 0,
    width: Math.floor(width / 2), // Left half of screen
    height: height, // Full height
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  startCycle();
});

async function shouldVisitJob(url) {
  try {
    const cleanUrl = url.split('?')[0];

    const response = await fetch('http://52.71.253.188:3000/api/jobs/shouldVisit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl })
    });

    const json = await response.json();
    // console.log(`[Check] shouldVisitJob →`, JSON.stringify(json, null, 2));
    return json.data?.shouldVisit ?? false;
  } catch (err) {
    console.error('[Duplication Check Error]', err.message);
    return false;
  }
}


async function startCycle() {

  await sendHeartbeat({ status: 'navigating_feed', message: 'Opening Upwork job feed' });


  // await win.loadURL('https://www.upwork.com/nx/search/jobs/?page=1&per_page=50&sort=recency');
  const baseUrl = 'https://www.upwork.com/nx/search/jobs/?page=1&per_page=50&sort=recency';
  const rawQuery = process.env.SEARCH_QUERY;

  let finalUrl;

  if (rawQuery && rawQuery.trim() !== '') {
    const encodedQuery = encodeURIComponent(rawQuery.trim()); // encodes "game development" to "game%20development"
    finalUrl = `${baseUrl}&q=${encodedQuery}`;
  } else {
    finalUrl = baseUrl;
  }

  console.log(`🔍 Using Upwork URL: ${finalUrl}`);
  await win.loadURL(finalUrl);

  await wait(4000);
  await solveCloudflareIfPresent(win);

  // 🛑 Check for login redirect
  if (await isLoginPage(win)) {
    console.warn('[Login Detected] Bot was redirected to login page!');
    await sendHeartbeat({
      status: 'stuck',
      message: '⚠️ Bot stuck at login — refresh cookies',
      jobUrl: ''
    });

    return; // stop bot cycle
  }

  await sendHeartbeat({ status: 'scraping_feed', message: 'Extracting 50 job links' });

  console.log('[Cycle] Scraping feed...');

  await scrapeFeedJobs();

  for (let i = 0; i < jobList.length; i++) {
    const job = jobList[i];

    const shouldVisit = await shouldVisitJob(job.url);
    if (!shouldVisit) {
      console.log(`[Skip] Job ${i + 1} already exists, skipping`);
      continue;
    }

    console.log(`[Detail] Visiting job ${i + 1}: ${job.url}`);

    await sendHeartbeat({
      status: 'visiting_job_detail',
      message: job.title,
      jobUrl: job.url
    });

    await win.loadURL(job.url);

    // 🔁 Add race between short delay and cloudflare check
    await Promise.race([
      wait(2000 + Math.floor(Math.random() * 1000)), // 2-3s max wait
      solveCloudflareIfPresent(win),                // will exit immediately if not present
    ]);

    // 🛑 Sanity check – HTML loaded or fallback wait
    const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
    if (htmlLengthCheck < 10000) {
      console.log(`[Warn] Job ${i + 1} page may not be fully loaded. Waiting extra...`);
      await wait(1500);
    }

    await sendHeartbeat({
      status: 'scraping_job',
      message: `Scraping job ${i + 1} details`,
      jobUrl: job.url
    });

    const details = await dumpAndExtractJobDetails(i, job.url);
    jobList[i] = { ...job, ...details };

    console.log(`[Detail] Scraped Job ${i + 1}:`, jobList[i]);

    await sendHeartbeat({
      status: 'saving_to_db',
      message: `Posting job ${i + 1} to backend`,
      jobUrl: job.url
    });

    await postJobToBackend(jobList[i]);

    // 🔁 Add small randomized delay between jobs to mimic human pacing
    const delayBetweenJobs = 1000 + Math.floor(Math.random() * 1000); // 1–2s
    await wait(delayBetweenJobs);
  }

  await sendHeartbeat({
    status: 'cycle_complete',
    message: `Cycle complete — scraped ${jobList.length} jobs`
  });


  console.log('\n[Summary] Scraped:\n');
  jobList.forEach((j, i) => {
    console.log(`[${i + 1}] ${j.title}`);
    console.log(`  Job URL: ${j.url.split('?')[0]}`);
    console.log(`  Job Posted At: ${j.postedDate}`);
    console.log(`  Job Main Category: ${j.mainCategory}`);
    console.log(`  Job Duration: ${j.projectDuration}`);
    console.log(`  Job Required Experience: ${j.experienceLevel}`);
    console.log(`  Job Pricing Model: ${j.pricingModel}`);
    console.log(`  Job Min Budget: ${j.minRange}`);
    console.log(`  Job Max Budget: ${j.maxRange}`);
    console.log(`  Job Description:\n${j.description?.substring(0, 300)}...\n`);
    console.log(`  Client Country: ${j.clientCountry}`);
    console.log(`  Client City: ${j.clientCity}`);
    console.log(`  Client Total Spend: ${j.clientSpend}`);
    console.log(`  Client Jobs Posted: ${j.clientJobsPosted}`);
    console.log(`  Client Payment Verified ? : ${j.paymentVerified}`);
    console.log(`  Client Phone Verified ? : ${j.paymentVerified}`);
    console.log(`  Client Hires: ${j.clientHires}`);
    console.log(`  Client Hire Rate: ${j.clientHireRate}`);
    console.log(`  Client Average Hourly Rate: ${j.clientAverageHourlyRate}`);
    console.log(`  Client Member Since: ${j.clientMemberSince}`);

  });

  const delay = 20000 + Math.floor(Math.random() * 20000);
  console.log(`[Cycle] Waiting ${delay / 1000}s before next cycle...`);

  await sendHeartbeat({
    status: 'idle',
    message: `Sleeping for ${delay / 1000}s before next cycle`
  });

  await wait(delay);
  jobList = [];
  startCycle();
}

async function scrapeFeedJobs() {
  console.log('[Feed] Scraping up to 50 jobs from feed...');
  jobList = await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('a'))
      .filter(a => a.href.includes('/jobs/') && a.innerText.trim().length > 10)
      .slice(0, 50)
      .map(a => ({
        title: a.innerText.trim(),
        url: a.href.startsWith('http') ? a.href : 'https://www.upwork.com' + a.getAttribute('href')
      }));
  `);

  console.log(`[Feed] Found ${jobList.length} valid job links.`);
}

async function solveCloudflareIfPresent(win) {
  console.log('[Cloudflare] Checking...');

  // Use a single, more robust detection expression
  const isCloudflare = await win.webContents.executeJavaScript(`
    (() => {
      const titleCheck = document.title.toLowerCase().includes("just a moment");
      const formCheck = !!document.querySelector('form[action*="cdn-cgi/challenge-platform"]');
      const textCheck = document.body && document.body.innerText.includes("Checking your browser");
      return titleCheck || formCheck || textCheck;
    })();
  `);

  if (isCloudflare) {

    await sendHeartbeat({ status: 'cloudflare_detected', message: 'Cloudflare detected, trying to solve' });

    console.log('[Cloudflare] Challenge detected. Running AHK...');

    // Slightly lower wait time, tuned with your improved AHK
    await wait(3000);
    win.focus();

    // AHK handles mouse wiggle + click + random move now
    await runAhkClick();

    // Slightly reduced wait, AHK now includes post-click behavior
    await wait(5000);

    // Recursive check again
    return await solveCloudflareIfPresent(win);
  } else {
    console.log('[Cloudflare] Passed.');

    await sendHeartbeat({ status: 'cloudflare_passed', message: 'Cloudflare Passed' });
  }
}


function runAhkClick() {
  return new Promise((resolve, reject) => {
    exec('click.ahk', (error) => {
      if (error) {
        console.error('[AHK] Error:', error.message);
        return reject(error);
      }
      resolve();
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dumpAndExtractJobDetails(index, originalUrl) {
  const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  const filePath = path.join(__dirname, 'html-dumps', `job_detail_dump_${index}.html`);
  fs.writeFileSync(filePath, html, 'utf-8');
  console.log(`[Debug] Dumped HTML to ${filePath}`);

  const buffer = fs.readFileSync(filePath);
  const rawHtml = new TextDecoder('utf-8').decode(buffer);

  const extractTitleAndCategory = () => {
    const match = rawHtml.match(/<title>(.*?)<\/title>/i);
    if (!match) return { title: '', mainCategory: '' };
    const [titlePart, categoryPart] = match[1].split(' - ');
    return {
      title: titlePart?.trim() || '',
      mainCategory: decodeHTMLEntities(categoryPart?.trim() || '')
    };
  };

  const extractDescription = () => {
    const summaryIndex = rawHtml.indexOf('Summary');
    if (summaryIndex === -1) return '';

    // Move to first ">" after Summary
    const nextGtIndex = rawHtml.indexOf('>', summaryIndex);
    if (nextGtIndex === -1) return '';

    // Find the end marker
    const endMarker = '<!----></div>';
    const endIndex = rawHtml.indexOf(endMarker, nextGtIndex);
    if (endIndex === -1) return '';

    const htmlBlock = rawHtml.substring(nextGtIndex + 1, endIndex).trim();

    // Strip tags and normalize spacing
    const textOnly = htmlBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return textOnly;
  };

  const extractProjectType = () => {
    const match = rawHtml.match(/Project Type:<\/strong>\s*<span[^>]*>(.*?)<\/span>/i);
    return match ? match[1].trim() : '';
  };

  const extractExperienceLevel = () => {
    const match = rawHtml.match(/<strong[^>]*>\s*(Entry|Intermediate|Expert)\s*<\/strong>/i);
    return match ? match[1].trim() : '';
  };

  const extractPostedAgoText = () => {
    const match = rawHtml.match(/>(\d+\s+\w+)\s+ago</i);
    return match ? match[1].trim() : '';
  };

  const calculatePostedDate = () => {
    const text = extractPostedAgoText().toLowerCase();
    const parts = text.split(' ');
    if (parts.length !== 2) return '';
    const value = parseInt(parts[0]);
    const unit = parts[1];
    const now = new Date();
    if (unit.startsWith('second')) now.setSeconds(now.getSeconds() - value);
    else if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() - value);
    else if (unit.startsWith('hour')) now.setHours(now.getHours() - value);
    else if (unit.startsWith('day')) now.setDate(now.getDate() - value);
    else if (unit.startsWith('week')) now.setDate(now.getDate() - value * 7);
    return now.toISOString();
  };

  const extractRequiredConnects = () => {
    // Case 1: Match number before "required connects"
    const match1 = rawHtml.match(/>([^<]*?)\s*required\s+connects/i);
    if (match1) {
      const num = match1[1].replace(/\s+/g, '').match(/\d+/);
      if (num) return parseInt(num[0], 10);
    }

    // Case 2: Match after "Send a proposal for:"
    const match2 = rawHtml.match(/Send a proposal for:\s*<[^>]*>([^<]*)<\/strong>/i);
    if (match2) {
      const cleaned = match2[1].replace(/connects?/i, '').replace(/\s+/g, '');
      const num = cleaned.match(/\d+/);
      if (num) return parseInt(num[0], 10);
    }

    return '';
  };


  const extractClientCountry = () => {
    const match = rawHtml.match(/<li[^>]*data-qa="client-location"[^>]*>\s*<strong[^>]*>(.*?)<\/strong>/i);
    return match ? match[1].trim() : '';
  };

  const extractClientCity = () => {
    const match = rawHtml.match(
      /<li[^>]*data-qa="client-location"[^>]*>[\s\S]*?<div[^>]*>\s*<span[^>]*>([^<]*)<\/span>/i
    );
    return match ? match[1].trim() : '';
  };

  const extractClientSpend = () => {
    const match = rawHtml.match(/>([^<>]+)<[^<]*total spent/i);
    return match ? match[1].trim().replace(/\s+/g, '') : '';
  };


  const extractClientHires = () => {
    const match = rawHtml.match(/<div[^>]*data-qa="client-hires"[^>]*>([\s\S]*?)<\/div>/i);
    if (match) {
      const text = match[1].replace(/<[^>]*>/g, '').trim(); // Strip inner HTML
      const hiresMatch = text.match(/(\d+)\s+hires?/i);
      return hiresMatch ? parseInt(hiresMatch[1], 10) : '';
    }
    return '';
  };

  const extractHireRate = () => {
    const match = rawHtml.match(/>([^<>%]+)%\s*hire rate/i);
    return match ? match[1].trim() : '';
  };


  const extractClientMemberSince = () => {
    const match = rawHtml.match(/Member since\s*([^<]+)/i);
    return match ? match[1].trim() : '';
  };


  const extractPaymentVerified = () => {
    return /payment method verified/i.test(rawHtml);
  };

  const extractPhoneVerified = () => {
    return /phone number verified/i.test(rawHtml);
  };

  const extractClientRating = () => {
    const index = rawHtml.indexOf('data-qa="client-location"');
    if (index === -1) return '';
    const snippet = rawHtml.slice(Math.max(0, index - 4000), index);
    const match = snippet.match(/Rating\s+is\s+(\d+(\.\d+)?)/i);
    return match ? parseFloat(match[1]) : '';
  };


  const extractClientReviews = () => {
    const index = rawHtml.indexOf('data-qa="client-location"');
    if (index === -1) return '';
    const snippet = rawHtml.slice(Math.max(0, index - 4000), index);
    const match = snippet.match(/(\d+)\s+reviews?/i);
    return match ? parseInt(match[1], 10) : '';
  };

  const extractClientJobsPosted = () => {
    const match = rawHtml.match(/(\d+)\s+jobs\s+posted/i);
    return match ? match[1].trim() : '';
  };

  const extractClientAverageHourlyRate = () => {
    const match = rawHtml.match(/<strong[^>]*data-qa="client-hourly-rate"[^>]*>\s*\$([\d,.]+)/i);
    if (!match) return '';
    return parseFloat(match[1].replace(/,/g, '')); // Remove comma, convert to float
  };


  const extractProjectPricingModel = () => {
    if (rawHtml.includes('Fixed-price</div>')) return 'Fixed';
    if (rawHtml.includes('Hourly</div>')) return 'Hourly';
    return '';
  };

  const extractBudgetRange = () => {
    const matches = [...rawHtml.matchAll(/<div[^>]+data-test="BudgetAmount"[^>]*>[\s\S]*?<strong[^>]*>\s*\$([\d,]+\.\d{2})\s*<\/strong>/gi)];

    if (matches.length === 1) {
      const amount = parseFloat(matches[0][1].replace(/,/g, ''));
      return { minRange: amount, maxRange: amount };
    }

    if (matches.length >= 2) {
      return {
        minRange: parseFloat(matches[0][1].replace(/,/g, '')),
        maxRange: parseFloat(matches[1][1].replace(/,/g, '')),
      };
    }

    return { minRange: 0, maxRange: 0 };
  };

  const { title, mainCategory } = extractTitleAndCategory();
  const { minRange, maxRange } = extractBudgetRange();

  return {
    title,
    url: originalUrl.split('?')[0],
    description: extractDescription(),
    mainCategory,
    experienceLevel: extractExperienceLevel(),
    projectType: extractProjectType(),
    postedDate: calculatePostedDate(),
    requiredConnects: extractRequiredConnects(),
    pricingModel: extractProjectPricingModel(),
    minRange: cleanDollarValue(minRange),
    maxRange: cleanDollarValue(maxRange),
    clientCountry: extractClientCountry(),
    clientCity: extractClientCity(),
    clientSpend: cleanDollarValue(extractClientSpend()),
    clientJobsPosted: extractClientJobsPosted(),
    clientHires: extractClientHires(),
    clientHireRate: extractHireRate(),
    clientAverageHourlyRate: cleanDollarValue(extractClientAverageHourlyRate()),
    clientMemberSince: extractClientMemberSince(),
    clientPaymentVerified: extractPaymentVerified(),
    clientPhoneVerified: extractPhoneVerified(),
    clientRating: extractClientRating(),
    clientReviews: extractClientReviews()
  };
}

function decodeHTMLEntities(text) {
  return text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function postJobToBackend(jobData) {
  try {

    jobData.url = jobData.url.split('?')[0];
    const response = await axios.post('http://52.71.253.188:3000/api/jobs/ingest', [jobData]);

    // Use proper fallback if response.data.inserted is undefined
    const insertedCount = response.data?.inserted || 1;
    console.log(`✅ Job posted: ${insertedCount} job(s)`);
  } catch (err) {
    console.error('❌ Failed to post job:', err.message);
  }
}

const cleanDollarValue = (val) => {
  if (!val || typeof val !== 'string') return 0;

  const cleaned = val.toString().trim().replace(/[$,]/g, '').toUpperCase();

  let multiplier = 1;
  let numberStr = cleaned;

  if (cleaned.endsWith('K')) {
    multiplier = 1000;
    numberStr = cleaned.replace(/K$/, '');
  } else if (cleaned.endsWith('M')) {
    multiplier = 1000000;
    numberStr = cleaned.replace(/M$/, '');
  }

  const num = parseFloat(numberStr);
  return isNaN(num) ? 0 : num * multiplier;
};


async function sendHeartbeat({ status, message = '', jobUrl = '' }) {
  try {
    // update global values
    currentStatus = status;
    currentMessage = message;
    currentJobUrl = jobUrl;

    const cleanURL = jobUrl?.split('?')[0];

    console.log('ENV BOT ID: ' + process.env.BOT_ID)

    const res = await fetch('http://52.71.253.188:3000/api/bots/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: process.env.BOT_ID || 'bot-001',
        status,
        message,
        jobUrl: cleanURL
      })
    });

    const json = await res.json();
    if (!json.success) {
      console.warn(`[Heartbeat Failed] ${json.message}`);
    } else {
      console.log(`🫀 [Heartbeat] Status: "${status}" — ${message}`);
    }
  } catch (err) {
    console.error('[Heartbeat Error]', err.message);
  }
}




