/**
 * test-extractions.js
 * Run: node test-extractions.js
 *
 * Tests all detailScraper extraction patterns against every HTML dump file.
 * Reports per-field success rates and flags files with poor extraction.
 */

const fs = require('fs');
const path = require('path');

const DUMP_DIRS = [
  path.join(__dirname, '..', 'html-dumps', 'html-dumps-set1'),
  path.join(__dirname, '..', 'html-dumps', 'html-dumps-set2'),
  path.join(__dirname, '..', 'html-dumps', 'html-dumps-set3'),
  path.join(__dirname, '..', 'html-dumps', 'html-dumps-set4'),
  path.join(__dirname, '..', 'html-dumps', 'html-dumps-set5'),
];

// ─── EXTRACTION FUNCTIONS (mirrors detailScraper.js logic) ───────────────────

function decodeHTMLEntities(text) {
  return text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractAll(rawHtml, fileName) {
  const results = {};

  // ── title & mainCategory ──────────────────────────────────────────────────
  const titleTagMatch = rawHtml.match(/<title>([^<]+)<\/title>/i);
  const titleStr = titleTagMatch ? titleTagMatch[1] : '';
  const isBrokenPage = !titleStr || titleStr.trim() === 'Upwork';

  results.title = (() => {
    if (isBrokenPage) return '';
    const m = titleStr.match(/^(.+?)\s*-\s*Freelance Job/i);
    return m ? decodeHTMLEntities(m[1].trim()) : '';
  })();

  results.mainCategory = (() => {
    if (isBrokenPage) return '';
    const m = titleStr.match(/Freelance Job in ([^-]+)/i);
    return m ? decodeHTMLEntities(m[1].trim()) : '';
  })();

  // ── description ───────────────────────────────────────────────────────────
  results.description = (() => {
    const descMatch = rawHtml.match(/data-test="Description"[\s\S]*?<p[^>]*class="[^"]*multiline-text[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (descMatch) return descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '…';

    const summaryIndex = rawHtml.indexOf('Summary');
    if (summaryIndex === -1) return '';
    const nextGtIndex = rawHtml.indexOf('>', summaryIndex);
    if (nextGtIndex === -1) return '';
    const endMarker = '<!----></div>';
    const endIndex = rawHtml.indexOf(endMarker, nextGtIndex);
    if (endIndex === -1) return '';
    const htmlBlock = rawHtml.substring(nextGtIndex + 1, endIndex).trim();
    return htmlBlock.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '…';
  })();

  // ── experienceLevel ──────────────────────────────────────────────────────
  results.experienceLevel = (() => {
    const m = rawHtml.match(/data-cy="expertise"[\s\S]{0,500}<div class="description"[^>]*>([^<]+)/i);
    if (m) return m[1].trim();
    const fallback = rawHtml.match(/<strong[^>]*>\s*(Entry level|Entry|Intermediate|Expert)\s*<\/strong>/i);
    return fallback ? fallback[1].trim() : '';
  })();

  // ── projectType ──────────────────────────────────────────────────────────
  results.projectType = (() => {
    const m = rawHtml.match(/<strong[^>]*>(One-time project|Ongoing project)<\/strong>/i);
    if (m) return m[1].replace(' project', '').trim();
    const labelMatch = rawHtml.match(/<strong[^>]*>([^<]+)<\/strong>[\s\S]{0,200}class="description"[^>]*>Project Type<\/div>/i);
    if (labelMatch) return labelMatch[1].trim();
    const fallback = rawHtml.match(/Project Type:<\/strong>\s*<span[^>]*>(.*?)<\/span>/i);
    return fallback ? fallback[1].trim() : '';
  })();

  // ── postedDate ───────────────────────────────────────────────────────────
  results.postedDate = (() => {
    let m = rawHtml.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (m) return m[0].trim();
    m = rawHtml.match(/Posted\s*<span[^>]*>(last\s+\w+)<\/span>/i);
    if (m) return m[1].trim();
    if (/Posted\s+yesterday/i.test(rawHtml)) return 'yesterday';
    if (/Posted\s+today/i.test(rawHtml)) return 'today';
    m = rawHtml.match(/<title>[^<]*posted\s+(\w+ \d+, \d{4})/i);
    if (m) return m[1];
    return '';
  })();

  // ── pricingModel ─────────────────────────────────────────────────────────
  results.pricingModel = (() => {
    if (/data-cy="fixed-price"/i.test(rawHtml) || rawHtml.includes('Fixed-price</div>')) return 'Fixed';
    if (/data-cy="clock-hourly"/i.test(rawHtml) || rawHtml.includes('Hourly</div>')) return 'Hourly';
    return '';
  })();

  // ── budget (minRange / maxRange) ─────────────────────────────────────────
  results.budget = (() => {
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
    if (ranges.length >= 1) return `$${ranges[0]}${ranges[1] ? ' – $' + ranges[1] : ''}`;

    const fixedMatch = rawHtml.match(/<strong[^>]*>\$([0-9,]+\.?\d*)<\/strong>[\s\S]{0,300}Fixed-price/i);
    if (fixedMatch) return `$${fixedMatch[1]} (fallback-A)`;

    const titleMatch = rawHtml.match(/<title>[^<]*\$([0-9,]+\.?\d*)\s*Fixed Price/i);
    if (titleMatch) return `$${titleMatch[1]} (fallback-B)`;

    const strongAmounts = [...rawHtml.matchAll(/<strong[^>]*>\$([0-9,]+\.?\d*)<\/strong>/g)]
      .map(m => m[1]).filter(v => !isNaN(parseFloat(v.replace(/,/g, ''))));
    if (strongAmounts.length >= 2) return `$${strongAmounts[0]} – $${strongAmounts[1]} (fallback-C)`;
    if (strongAmounts.length === 1) return `$${strongAmounts[0]} (fallback-C)`;

    return '';
  })();

  // ── clientCountry ────────────────────────────────────────────────────────
  results.clientCountry = (() => {
    const m = rawHtml.match(/data-qa="client-location"[^>]*>[\s\S]{0,100}<strong[^>]*>([^<]+)<\/strong>/i);
    return m ? m[1].trim() : '';
  })();

  // ── clientCity ───────────────────────────────────────────────────────────
  results.clientCity = (() => {
    const m = rawHtml.match(/data-qa="client-location"[^>]*>[\s\S]*?<span class="nowrap"[^>]*>([^<]+)<\/span>/i);
    return m ? m[1].trim() : '';
  })();

  // ── clientSpend ──────────────────────────────────────────────────────────
  results.clientSpend = (() => {
    const m = rawHtml.match(/data-qa="client-spend"[^>]*>[\s\S]{0,100}<span[^>]*>([^<]+)<\/span>/i);
    return m ? m[1].trim() : '';
  })();

  // ── clientJobsPosted ─────────────────────────────────────────────────────
  results.clientJobsPosted = 'N/A (no-login)';

  // ── clientHires ──────────────────────────────────────────────────────────
  results.clientHires = (() => {
    const m = rawHtml.match(/data-qa="client-hires"[^>]*>([^<]+)/i);
    if (m) { const num = m[1].match(/([\d,]+)\s+hires?/i); return num ? num[1].replace(/,/g, '') : ''; }
    return '';
  })();

  // ── clientHireRate ───────────────────────────────────────────────────────
  results.clientHireRate = 'N/A (no-login)';

  // ── clientMemberSince ────────────────────────────────────────────────────
  results.clientMemberSince = (() => {
    const m = rawHtml.match(/Member since\s*([^<]+)/i);
    return m ? m[1].trim() : '';
  })();

  // ── clientRating ─────────────────────────────────────────────────────────
  results.clientRating = 'N/A (no-login)';

  // ── clientReviews ────────────────────────────────────────────────────────
  results.clientReviews = 'N/A (no-login)';

  // ── requiredConnects (not available no-login) ────────────────────────────
  results.requiredConnects = 'N/A (no-login)';

  // ── paymentVerified / phoneVerified (not available no-login) ────────────
  results.clientPaymentVerified = 'N/A (no-login)';
  results.clientPhoneVerified = 'N/A (no-login)';

  // ── clientAverageHourlyRate (not available no-login) ────────────────────
  results.clientAverageHourlyRate = 'N/A (no-login)';

  results._broken = isBrokenPage;
  return results;
}

// ─── FIELDS TO TRACK ─────────────────────────────────────────────────────────
const FIELDS = [
  'title', 'mainCategory', 'description', 'experienceLevel', 'projectType',
  'postedDate', 'pricingModel', 'budget',
  'clientCountry', 'clientCity', 'clientSpend', 'clientHires', 'clientMemberSince',
];

const NA_FIELDS = [
  'requiredConnects', 'clientPaymentVerified', 'clientPhoneVerified',
  'clientAverageHourlyRate', 'clientJobsPosted', 'clientHireRate',
  'clientRating', 'clientReviews',
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
let totalFiles = 0;
let brokenFiles = 0;
const fieldHits = {};
const fieldMisses = {};
const missDetails = {}; // field -> [{file, title}]

FIELDS.forEach(f => { fieldHits[f] = 0; fieldMisses[f] = 0; missDetails[f] = []; });

for (const dir of DUMP_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort();

  for (const file of files) {
    const filePath = path.join(dir, file);
    const rawHtml = fs.readFileSync(filePath, 'utf-8');
    const setName = path.basename(dir);
    const label = `${setName}/${file}`;
    totalFiles++;

    const results = extractAll(rawHtml, label);

    if (results._broken) {
      brokenFiles++;
      // still count broken pages as misses for all fields
      FIELDS.forEach(f => {
        fieldMisses[f]++;
        if (missDetails[f].length < 5) missDetails[f].push({ file: label, title: '(broken page)' });
      });
      continue;
    }

    FIELDS.forEach(f => {
      const val = results[f];
      if (val && val !== '' && val !== '…') {
        fieldHits[f]++;
      } else {
        fieldMisses[f]++;
        if (missDetails[f].length < 5) missDetails[f].push({ file: label, title: results.title || '(no title)' });
      }
    });
  }
}

// ─── REPORT ──────────────────────────────────────────────────────────────────
const goodFiles = totalFiles - brokenFiles;

console.log('\n' + '='.repeat(80));
console.log(`  SCRAPER EXTRACTION TEST REPORT`);
console.log(`  Total files: ${totalFiles}  |  Broken pages: ${brokenFiles}  |  Valid: ${goodFiles}`);
console.log('='.repeat(80));

console.log('\n📊 PER-FIELD RESULTS (against all ' + totalFiles + ' files):');
console.log('-'.repeat(80));

const PAD_FIELD = 26;
const PAD_BAR = 30;

FIELDS.forEach(f => {
  const hits = fieldHits[f];
  const total = totalFiles;
  const pct = Math.round((hits / total) * 100);
  const barFilled = Math.round((pct / 100) * PAD_BAR);
  const bar = '█'.repeat(barFilled) + '░'.repeat(PAD_BAR - barFilled);
  const status = pct >= 80 ? '✅' : pct >= 40 ? '⚠️ ' : '❌';
  console.log(`${status} ${f.padEnd(PAD_FIELD)} ${bar} ${String(pct).padStart(3)}%  (${hits}/${total})`);
});

console.log('\n🚫 NOT AVAILABLE IN NO-LOGIN MODE:');
NA_FIELDS.forEach(f => console.log(`   - ${f}`));

console.log('\n🔍 MISS DETAILS (first 5 misses per field):');
console.log('-'.repeat(80));
FIELDS.forEach(f => {
  if (fieldMisses[f] === 0) return;
  if (fieldMisses[f] === brokenFiles && fieldHits[f] === goodFiles) return; // only broken pages missed
  console.log(`\n  ${f} (${fieldMisses[f]} misses):`);
  missDetails[f].forEach(d => console.log(`    - ${d.file}  →  "${d.title.slice(0, 60)}"`));
});

console.log('\n' + '='.repeat(80));
console.log('Done.\n');
