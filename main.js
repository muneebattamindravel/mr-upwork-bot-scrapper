const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

let win;
let jobList = [];

app.whenReady().then(async () => {
  const ses = session.defaultSession;

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

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  startCycle();
});

async function startCycle() {
  await win.loadURL('https://www.upwork.com/nx/search/jobs/?page=1&per_page=50&sort=recency');
  await wait(8000);
  await solveCloudflareIfPresent(win);
  console.log('[Cycle] Scraping feed...');

  await scrapeFeedJobs();

  for (let i = 0; i < jobList.length; i++) {
    const job = jobList[i];
    console.log(`[Detail] Visiting job ${i + 1}: ${job.url}`);
    await win.loadURL(job.url);
    await wait(12000); // safer for detail load
    await solveCloudflareIfPresent(win);

    const htmlLengthCheck = await win.webContents.executeJavaScript('document.documentElement.outerHTML.length');
    if (htmlLengthCheck < 10000) {
      console.log(`[Warn] Job ${i + 1} page may not be fully loaded. Waiting extra...`);
      await wait(5000);
    }

    const details = await dumpAndExtractJobDetails(i, job.url);
    jobList[i] = { ...job, ...details };

    console.log(`[Detail] Scraped Job ${i + 1}:`, jobList[i]);

    await postJobToBackend(jobList[i]);

    await wait(2000);
  }

  console.log('\n[Summary] Scraped:\n');
  jobList.forEach((j, i) => {
    console.log(`[${i + 1}] ${j.title}`);
    console.log(`  URL: ${j.url}`);
    console.log(`  Posted: ${j.postedDate}`);
    console.log(`  Category: ${j.mainCategory}`);
    console.log(`  Duration: ${j.projectDuration}`);
    console.log(`  Experience: ${j.experienceLevel}`);
    console.log(`  Payment: ${j.paymentVerified}`);
    console.log(`  Country: ${j.clientCountry}`);
    console.log(`  Client Total Spend: ${j.clientSpend}`);
    console.log(`  Client Jobs Posted: ${j.clientJobsPosted}`);
    console.log(`  Client Hires: ${j.clientHires}`);
    console.log(`  Client Hire Rate: ${j.clientHireRate}`);
    console.log(`  Client Member Since: ${j.clientMemberSince}`);
    console.log(`  Description:\n${j.description?.substring(0, 300)}...\n`);
  });

  const delay = 20000 + Math.floor(Math.random() * 20000);
  console.log(`[Cycle] Waiting ${delay / 1000}s before next cycle...`);
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
  const isCloudflare = await win.webContents.executeJavaScript(`
    document.title.includes("Just a moment") ||
    !!document.querySelector('form[action*="cdn-cgi/challenge-platform"]') ||
    document.body.innerText.includes("Checking your browser")
  `);

  if (isCloudflare) {
    console.log('[Cloudflare] Challenge detected. Running AHK...');
    await wait(5000);
    win.focus();
    await runAhkClick();
    await wait(10000);
    return await solveCloudflareIfPresent(win);
  } else {
    console.log('[Cloudflare] Passed.');
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
  const filePath = path.join(__dirname, `job_detail_dump_${index}.html`);
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

  const extractClientSpend = () => {
    const match = rawHtml.match(/>([^<>]+)<[^<]*total spent/i);
    return match ? match[1].trim().replace(/\s+/g, '') : '';
  };


  const extractClientHires = () => {
    const match = rawHtml.match(/<span[^>]*>\s*(\d+)\s*<\/span>\s*hire/i);
    return match ? match[1].trim() : '';
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

  const extractClientRatingAndReviews = () => {
    const match = rawHtml.match(/>(\d\.\d{1,2}) of (\d+) reviews?\s*</i);
    if (!match) return { clientRating: '', clientReviews: '' };
    return {
      clientRating: match[1],
      clientReviews: match[2]
    };
  };

  const extractClientJobsPosted = () => {
    const match = rawHtml.match(/(\d+)\s+jobs\s+posted/i);
    return match ? match[1].trim() : '';
  };


  const { title, mainCategory } = extractTitleAndCategory();
  const { clientRating, clientReviews } = extractClientRatingAndReviews();

  return {
    title,
    url: originalUrl,
    description: extractDescription(),
    mainCategory,
    experienceLevel: extractExperienceLevel(),
    projectType: extractProjectType(),
    postedDate: calculatePostedDate(),
    requiredConnects: extractRequiredConnects(),
    clientCountry: extractClientCountry(),
    clientSpend: extractClientSpend(),
    clientJobsPosted: extractClientJobsPosted(),
    clientHires: extractClientHires(),
    clientHireRate: extractHireRate(),
    clientMemberSince: extractClientMemberSince(),
    clientPaymentVerified: extractPaymentVerified(),
    clientRating,
    clientReviews
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
    const response = await axios.post('http://52.71.253.188:3000/api/jobs/ingest', [jobData]); // ← wrapped in array
    console.log(`✅ Job posted: ${response.data.inserted} job(s)`);
  } catch (err) {
    console.error('❌ Failed to post job:', err.message);
  }
}








