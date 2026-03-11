const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../html-dumps/html-dumps-set3/job_detail_dump_5.html');
const html = fs.readFileSync(FILE, 'utf-8');

function ctx(needle, before = 50, after = 300) {
  const idx = html.indexOf(needle);
  if (idx === -1) return `NOT FOUND: "${needle}"`;
  return html.slice(Math.max(0, idx - before), idx + needle.length + after);
}

console.log('\n=== RATING + REVIEWS context ===');
console.log(ctx('Rating is', 300, 500));

console.log('\n=== client-spend data-qa ===');
console.log(ctx('data-qa="client-spend"', 20, 300));

console.log('\n=== client-hires data-qa ===');
console.log(ctx('data-qa="client-hires"', 20, 100));

console.log('\n=== client-location data-qa ===');
console.log(ctx('data-qa="client-location"', 20, 300));

console.log('\n=== client-contract-date data-qa ===');
console.log(ctx('data-qa="client-contract-date"', 20, 150));

console.log('\n=== jobs posted? ===');
const jp = html.match(/\d+\s+jobs?\s+posted/gi);
console.log(jp || 'NOT FOUND');
