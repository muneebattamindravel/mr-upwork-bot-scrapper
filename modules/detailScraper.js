const fs = require('fs');
const path = require('path');
const { sendHeartbeat } = require('./heartbeat');
const { cleanDollarValue } = require('./utils');
const { log } = require('./utils');

async function scrapeJobDetail(win, index, jobUrl) {
  try {

    return dumpAndExtractJobDetails(win, index, jobUrl);

  } catch (err) {
    console.error(`[❌ scrapeJobDetail] Failed for index ${index} – ${err.message}`);
    await sendHeartbeat({
      status: 'job_detail_error',
      message: err.message,
      jobUrl,
    });
    return null;
  }
}

function decodeHTMLEntities(text) {
  return text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function dumpAndExtractJobDetails(win, index, originalUrl) {
  const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  const filePath = path.join(__dirname, '..', 'html-dumps', `job_detail_dump_${index}.html`);

  fs.writeFileSync(filePath, html, 'utf-8');

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
      const hiresMatch = text.match(/([\d,]+)\s+hires?/i);
      return hiresMatch ? parseInt(hiresMatch[1].replace(/,/g, '')) : '';
    }
    return '';
  };


  const extractHireRate = () => {
    const match = rawHtml.match(/>([\d,.]+)%\s*hire rate/i);
    return match ? parseFloat(match[1].replace(/,/g, '')) : '';
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
    const match = snippet.match(/([\d,]+)\s+reviews?/i);
    return match ? parseInt(match[1].replace(/,/g, '')) : '';
  };


  const extractClientJobsPosted = () => {
    const match = rawHtml.match(/([\d,]+)\s+jobs\s+posted/i);
    return match ? parseInt(match[1].replace(/,/g, '')) : '';
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
    const matches = [
      ...rawHtml.matchAll(
        /<div[^>]+data-test="BudgetAmount"[^>]*>[\s\S]*?\$([\d,]+\.\d{2})/gi
      )
    ];

    if (matches.length === 1) {
      const amount = parseFloat(matches[0][1].replace(/,/g, ''));
      return { minRange: amount, maxRange: amount };
    }

    if (matches.length >= 2) {
      return {
        minRange: parseFloat(matches[0][1].replace(/,/g, '')),
        maxRange: parseFloat(matches[1][1].replace(/,/g, ''))
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

module.exports = {
  scrapeJobDetail
};
