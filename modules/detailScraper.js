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

  try {

    // [FIX S3] Get HTML directly from browser — no need to read back from disk
    const rawHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    // const filePath = path.join(__dirname, '..', 'html-dumps', `job_detail_dump_${index}.html`);
    // fs.promises.writeFile(filePath, rawHtml, 'utf-8').catch(e => log('[detailScraper] Dump write failed:', e.message));
    // const buffer = fs.readFileSync(filePath);
    // const rawHtml = new TextDecoder('utf-8').decode(buffer);

    // ─── TITLE & CATEGORY ────────────────────────────────────────────────────
    // Title format (no-login): "Job Title - Freelance Job in Category - Budget/Hours - Upwork"
    const extractTitleAndCategory = () => {
      const match = rawHtml.match(/<title>([^<]+)<\/title>/i);
      if (!match || match[1].trim() === 'Upwork') return { title: '', jobCategory: '' };
      const titleStr = match[1];

      // Everything before " - Freelance Job"
      const titleMatch = titleStr.match(/^(.+?)\s*-\s*Freelance Job/i);
      // Everything after "Freelance Job in " up to next " - "
      const categoryMatch = titleStr.match(/Freelance Job in ([^-]+)/i);

      // Fallback: "Job Title | Upwork" format (no category available)
      const pipeMatch = !titleMatch && titleStr.match(/^(.+?)\s*\|\s*Upwork/i);

      return {
        title: titleMatch
          ? decodeHTMLEntities(titleMatch[1].trim())
          : pipeMatch ? decodeHTMLEntities(pipeMatch[1].trim()) : '',
        jobCategory: categoryMatch ? decodeHTMLEntities(categoryMatch[1].trim()) : ''
      };
    };

    // ─── DESCRIPTION ─────────────────────────────────────────────────────────
    // Primary v2: text-extraction from the entire data-test="Description" section.
    // This replaces the old single-<p> regex which silently missed jobs whose
    // description started with a short header paragraph (e.g. "<p><strong>Skills:</strong></p>")
    // causing the < 50-char guard in main.js to skip the whole job.
    // Fallback A: multiline-text regex (first <p> only — kept for structure detection)
    // Fallback B: Summary marker (old logged-in format)
    const extractDescription = () => {
      // Primary v3: find data-test="Description" container, walk div-depth to its closing </div>
      // so we ONLY extract the description text — nothing from adjacent sections
      // (Activity on this job, Skills, Project Type, etc. are siblings, not children).
      const sectionIdx = rawHtml.indexOf('data-test="Description"');
      if (sectionIdx !== -1) {
        const tagClose = rawHtml.indexOf('>', sectionIdx);
        if (tagClose !== -1) {
          // Walk forward tracking nested <div> opens/closes to find the matching </div>
          let depth = 1;
          let pos   = tagClose + 1;
          const MAX_SCAN = 20000; // safety cap — bail if no closing tag found within 20KB
          const scanEnd  = Math.min(pos + MAX_SCAN, rawHtml.length);

          while (pos < scanEnd && depth > 0) {
            const nextOpen  = rawHtml.indexOf('<div', pos);
            const nextClose = rawHtml.indexOf('</div>', pos);
            if (nextClose === -1) break; // malformed HTML
            if (nextOpen !== -1 && nextOpen < nextClose) {
              // Another <div opens before the next </div closes — go deeper
              depth++;
              pos = nextOpen + 4;
            } else {
              depth--;
              if (depth === 0) {
                // Found the closing </div> of the Description container
                const inner = rawHtml.substring(tagClose + 1, nextClose);
                const text  = inner
                  .replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (text.length > 30) return text;
                break;
              }
              pos = nextClose + 6; // move past </div>
            }
          }
        }
      }

      // Fallback A: first multiline-text <p> (old primary — catches edge cases)
      const descMatch = rawHtml.match(/data-test="Description"[\s\S]*?<p[^>]*class="[^"]*multiline-text[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      if (descMatch) {
        return descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // Fallback B: Summary keyword approach (logged-in page format)
      const summaryIndex = rawHtml.indexOf('Summary');
      if (summaryIndex === -1) return '';
      const nextGtIndex = rawHtml.indexOf('>', summaryIndex);
      if (nextGtIndex === -1) return '';
      const endMarker = '<!----></div>';
      const endIndex = rawHtml.indexOf(endMarker, nextGtIndex);
      if (endIndex === -1) return '';
      const htmlBlock = rawHtml.substring(nextGtIndex + 1, endIndex).trim();
      return htmlBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    };

    // ─── EXPERIENCE LEVEL ────────────────────────────────────────────────────
    // Primary: data-cy="expertise" followed by <div class="description">
    // Fallback: <strong> tag (old logged-in format)
    const extractExperienceLevel = () => {
      const match = rawHtml.match(/data-cy="expertise"[\s\S]{0,500}<div class="description"[^>]*>([^<]+)/i);
      if (match) return match[1].trim();

      // Fallback
      const fallback = rawHtml.match(/<strong[^>]*>\s*(Entry level|Entry|Intermediate|Expert)\s*<\/strong>/i);
      return fallback ? fallback[1].trim() : '';
    };

    // ─── PROJECT TYPE ─────────────────────────────────────────────────────────
    // Primary: <strong>One-time project</strong> or <strong>Ongoing project</strong>
    // Fallback B: <strong>VALUE</strong><div class="description">Project Type</div>
    // Fallback C: "Project Type:" label (old logged-in format)
    const extractProjectType = () => {
      const match = rawHtml.match(/<strong[^>]*>(One-time project|Ongoing project)<\/strong>/i);
      if (match) return match[1].replace(' project', '').trim(); // → "One-time" or "Ongoing"

      // Fallback B: no-login format where label follows the value
      const labelMatch = rawHtml.match(/<strong[^>]*>([^<]+)<\/strong>[\s\S]{0,200}class="description"[^>]*>Project Type<\/div>/i);
      if (labelMatch) return labelMatch[1].trim();

      // Fallback C: old logged-in format
      const fallback = rawHtml.match(/Project Type:<\/strong>\s*<span[^>]*>(.*?)<\/span>/i);
      return fallback ? fallback[1].trim() : '';
    };

    // ─── POSTED DATE ─────────────────────────────────────────────────────────
    const extractPostedAgoText = () => {
      // 1. Relative numeric anchored near "Posted" keyword: "3 hours ago", "2 days ago", etc.
      let match = rawHtml.match(/Posted[\s\S]{0,150}?(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
      if (match) return match[1].trim();

      // 2. "last week" / "last month" inside posted-on-line span
      match = rawHtml.match(/Posted\s*<span[^>]*>(last\s+\w+)<\/span>/i);
      if (match) return match[1].trim();

      // 3. "yesterday" / "today"
      if (/Posted\s+yesterday/i.test(rawHtml)) return 'yesterday';
      if (/Posted\s+today/i.test(rawHtml)) return 'today';

      // 4. Exact date from title: "posted December 11, 2025"
      const titleMatch = rawHtml.match(/<title>[^<]*posted\s+(\w+ \d+, \d{4})/i);
      if (titleMatch) return `date:${titleMatch[1]}`;

      return null;
    };

    const calculatePostedDate = () => {
      const text = extractPostedAgoText();
      if (!text) return null;

      // Exact date string from title
      if (text.startsWith('date:')) {
        const date = new Date(text.slice(5));
        return isNaN(date.getTime()) ? null : date;
      }

      const now = new Date();

      if (text === 'yesterday') { now.setDate(now.getDate() - 1); return now; }
      if (text === 'today') return now;
      if (/last\s+week/i.test(text)) { now.setDate(now.getDate() - 7); return now; }
      if (/last\s+month/i.test(text)) { now.setMonth(now.getMonth() - 1); return now; }

      const parts = text.toLowerCase().split(' ');
      if (parts.length < 2) return now;
      const value = parseInt(parts[0]);
      const unit = parts[1];

      if (unit.startsWith('second')) now.setSeconds(now.getSeconds() - value);
      else if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() - value);
      else if (unit.startsWith('hour')) now.setHours(now.getHours() - value);
      else if (unit.startsWith('day')) now.setDate(now.getDate() - value);
      else if (unit.startsWith('week')) now.setDate(now.getDate() - value * 7);
      else if (unit.startsWith('month')) now.setMonth(now.getMonth() - value);
      else if (unit.startsWith('year')) now.setFullYear(now.getFullYear() - value);

      return now;
    };

    // ─── REQUIRED CONNECTS ───────────────────────────────────────────────────
    // NOT available on no-login pages — kept for potential future re-use
    const extractRequiredConnects = () => {
      // Case 1: Match number before "required connects"
      // const match1 = rawHtml.match(/>([^<]*?)\s*required\s+connects/i);
      // if (match1) { const num = match1[1].replace(/\s+/g, '').match(/\d+/); if (num) return parseInt(num[0], 10); }
      // Case 2: Match after "Send a proposal for:"
      // const match2 = rawHtml.match(/Send a proposal for:\s*<[^>]*>([^<]*)<\/strong>/i);
      // if (match2) { const cleaned = match2[1].replace(/connects?/i, '').replace(/\s+/g, ''); const num = cleaned.match(/\d+/); if (num) return parseInt(num[0], 10); }
      return '';
    };

    // ─── CLIENT COUNTRY & CITY ───────────────────────────────────────────────
    // Structure: data-qa="client-location" > <strong>Country</strong> > <span class="nowrap">City</span>
    const extractClientCountry = () => {
      const match = rawHtml.match(/data-qa="client-location"[^>]*>[\s\S]{0,100}<strong[^>]*>([^<]+)<\/strong>/i);
      return match ? match[1].trim() : '';
    };

    const extractClientCity = () => {
      const match = rawHtml.match(/data-qa="client-location"[^>]*>[\s\S]*?<span class="nowrap"[^>]*>([^<]+)<\/span>/i);
      return match ? match[1].trim() : '';
    };

    // ─── CLIENT SPEND ────────────────────────────────────────────────────────
    // Structure: data-qa="client-spend" > <span>$648K</span> total spent
    const extractClientSpend = () => {
      const match = rawHtml.match(/data-qa="client-spend"[^>]*>[\s\S]{0,100}<span[^>]*>([^<]+)<\/span>/i);
      return match ? match[1].trim() : '';
    };

    // ─── CLIENT HIRES ────────────────────────────────────────────────────────
    // Structure: data-qa="client-hires">1,841 hires, 375 active</div>
    const extractClientHires = () => {
      const match = rawHtml.match(/data-qa="client-hires"[^>]*>([^<]+)/i);
      if (match) {
        const num = match[1].match(/([\d,]+)\s+hires?/i);
        return num ? parseInt(num[1].replace(/,/g, '')) : '';
      }
      return '';
    };

    // ─── HIRE RATE ───────────────────────────────────────────────────────────
    // NOT available on no-login pages
    const extractHireRate = () => {
      return '';
    };

    // ─── CLIENT MEMBER SINCE ─────────────────────────────────────────────────
    const extractClientMemberSince = () => {
      const match = rawHtml.match(/Member since\s*([^<]+)/i);
      return match ? match[1].trim() : '';
    };

    // ─── PAYMENT / PHONE VERIFIED ────────────────────────────────────────────
    // These are NOT shown on no-login pages — always return false
    // Kept as comments for reference if login mode is re-enabled
    const extractPaymentVerified = () => {
      // return /payment method verified/i.test(rawHtml);
      return false;
    };

    const extractPhoneVerified = () => {
      // return /phone number verified/i.test(rawHtml);
      return false;
    };

    // ─── CLIENT RATING & REVIEWS ─────────────────────────────────────────────
    // NOT available per-client on no-login pages.
    // The "Rating is 4.9" shown on Upwork public pages is Upwork's platform-wide
    // average (Average rating of clients by professionals), not this client's rating.
    const extractClientRating = () => {
      return '';
    };

    const extractClientReviews = () => {
      return '';
    };

    // ─── CLIENT JOBS POSTED ──────────────────────────────────────────────────
    // NOT available on no-login pages
    const extractClientJobsPosted = () => {
      return '';
    };

    // ─── CLIENT AVERAGE HOURLY RATE ──────────────────────────────────────────
    // NOT available on no-login pages
    const extractClientAverageHourlyRate = () => {
      // return /data-qa="client-hourly-rate"/ approach was for logged-in pages only
      return '';
    };

    // ─── PRICING MODEL ───────────────────────────────────────────────────────
    // Checks for data-cy attributes or description divs
    const extractProjectPricingModel = () => {
      if (/data-cy="fixed-price"/i.test(rawHtml) || rawHtml.includes('Fixed-price</div>')) return 'Fixed';
      if (/data-cy="clock-hourly"/i.test(rawHtml) || rawHtml.includes('Hourly</div>')) return 'Hourly';
      return '';
    };

    // ─── BUDGET RANGE ────────────────────────────────────────────────────────
    // Primary: BudgetAmount keyword (still works on some pages)
    // Fallback A: <strong>$X.XX</strong> near Fixed-price (no-login format)
    // Fallback B: Title tag "$X.XX Fixed Price"
    function extractBudgetRange() {
      const ranges = [];
      const budgetKeyword = 'BudgetAmount';
      let idx = 0;

      while ((idx = rawHtml.indexOf(budgetKeyword, idx)) !== -1) {
        let i = idx;
        while (i < rawHtml.length && rawHtml[i] !== '$') i++;
        if (i >= rawHtml.length) break;
        i++;
        const valueChars = [];
        while (i < rawHtml.length && rawHtml[i] !== '<') { valueChars.push(rawHtml[i]); i++; }
        const amount = parseFloat(valueChars.join('').trim().replace(/,/g, ''));
        if (!isNaN(amount)) ranges.push(amount);
        idx += budgetKeyword.length;
      }

      if (ranges.length === 1) return { minRange: ranges[0], maxRange: ranges[0] };
      if (ranges.length >= 2) return { minRange: ranges[0], maxRange: ranges[1] };

      // Fallback A: <strong>$X</strong> appearing before "Fixed-price"
      const fixedMatch = rawHtml.match(/<strong[^>]*>\$([0-9,]+\.?\d*)<\/strong>[\s\S]{0,300}Fixed-price/i);
      if (fixedMatch) {
        const amount = parseFloat(fixedMatch[1].replace(/,/g, ''));
        if (!isNaN(amount)) return { minRange: amount, maxRange: amount };
      }

      // Fallback B: title tag "$X,XXX.XX Fixed Price"
      const titleMatch = rawHtml.match(/<title>[^<]*\$([0-9,]+\.?\d*)\s*Fixed Price/i);
      if (titleMatch) {
        const amount = parseFloat(titleMatch[1].replace(/,/g, ''));
        if (!isNaN(amount)) return { minRange: amount, maxRange: amount };
      }

      // Fallback C: hourly/fixed rate shown as <strong>$X</strong> pair in pricing section
      const strongAmounts = [...rawHtml.matchAll(/<strong[^>]*>\$([0-9,]+\.?\d*)<\/strong>/g)]
        .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => !isNaN(n));
      if (strongAmounts.length >= 2) return { minRange: strongAmounts[0], maxRange: strongAmounts[1] };
      if (strongAmounts.length === 1) return { minRange: strongAmounts[0], maxRange: strongAmounts[0] };

      return { minRange: 0, maxRange: 0 };
    }

    const { title, jobCategory } = extractTitleAndCategory();
    const { minRange, maxRange } = extractBudgetRange();

    return {
      title:                   title || '',
      url:                     originalUrl.split('?')[0],
      description:             extractDescription() || '',
      jobCategory:             jobCategory || '',
      experienceLevel:         extractExperienceLevel() || '',
      projectType:             extractProjectType() || '',
      postedDate:              calculatePostedDate() ?? null,
      requiredConnects:        extractRequiredConnects() || 0,
      pricingModel:            extractProjectPricingModel() || '',
      minRange:                cleanDollarValue(minRange) ?? 0,
      maxRange:                cleanDollarValue(maxRange) ?? 0,
      clientCountry:           extractClientCountry() || '',
      clientCity:              extractClientCity() || '',
      clientSpend:             cleanDollarValue(extractClientSpend()) ?? 0,
      clientJobsPosted:        extractClientJobsPosted() || 0,
      clientHires:             extractClientHires() || 0,
      clientHireRate:          extractHireRate() || 0,
      clientAverageHourlyRate: cleanDollarValue(extractClientAverageHourlyRate()) ?? 0,
      clientMemberSince:       extractClientMemberSince() || '',
      clientPaymentVerified:   extractPaymentVerified() ?? false,
      clientPhoneVerified:     extractPhoneVerified() ?? false,
      clientRating:            extractClientRating() || 0,
      clientReviews:           extractClientReviews() || 0,
    };
  }
  catch (exception) {
    // [FIX S5] Return null explicitly — caller does { ...job, ...details },
    // spreading undefined throws TypeError
    log('[detailScraper] Exception:', exception);
    return null;
  }
}

module.exports = {
  scrapeJobDetail
};
