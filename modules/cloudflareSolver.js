const path = require('path');
const { wait } = require('./utils');
const { sendHeartbeat } = require('./heartbeat');
const { getBotSettings } = require('./botSettings');
const { exec } = require('child_process');
const { log } = require('./utils');

// [FIX S4] Added depth param to prevent infinite recursion if Cloudflare never resolves
// progress: optional {queryIndex,queryTotal,queryName,jobIndex,jobTotal} — passed through
//           to heartbeat so the dashboard progress bars stay visible during CF challenges
async function solveCloudflareIfPresent(win, botId, depth = 0, progress = null) {
  if (depth >= 3) {
    log('[Cloudflare] Max retries reached. Moving on.');
    await sendHeartbeat({ status: 'cloudflare_failed', message: 'Could not solve Cloudflare after 3 attempts', statsInc: { cloudflareFailures: 1 }, progress });
    return;
  }
  log('[Cloudflare] Checking...');

  const isCloudflare = await win.webContents.executeJavaScript(`
    (() => {
      const titleCheck = document.title.toLowerCase().includes("just a moment");
      const formCheck = !!document.querySelector('form[action*="cdn-cgi/challenge-platform"]');
      const textCheck = document.body && document.body.innerText.includes("Checking your browser");
      return titleCheck || formCheck || textCheck;
    })();
  `);

  if (isCloudflare) {
    await sendHeartbeat({ status: 'cloudflare_detected', message: 'Cloudflare detected, solving…', progress });
    log('[Cloudflare] Detected. Solving...');

    const botSettings = await getBotSettings(botId);
    const waitBeforeClick = botSettings.cloudflareWaitBeforeClick || 3000;
    const waitAfterClick = botSettings.cloudflareWaitAfterClick || 5000;

    await wait(waitBeforeClick);
    win.focus();
    await runAhkClick();
    await wait(waitAfterClick);

    return await solveCloudflareIfPresent(win, botId, depth + 1, progress);
  } else {
    log('[Cloudflare] Passed.');
    await sendHeartbeat({ status: 'cloudflare_passed', message: 'Cloudflare Passed', progress });
  }
}

function runAhkClick() {
  return new Promise((resolve) => {
    // Use absolute path so this works regardless of Electron CWD
    // shell: true is required on Windows to execute .ahk files via file association
    const ahkPath = path.resolve(__dirname, '..', 'click.ahk');
    log('[AHK] Running:', ahkPath);
    exec(`"${ahkPath}"`, { shell: true }, (error) => {
      if (error) {
        // AHK errors are non-fatal — the script may have run and AHK just returned non-zero
        console.error('[AHK] exec error (non-fatal):', error.message);
      }
      resolve(); // always resolve so the scraper continues
    });
  });
}

module.exports = { solveCloudflareIfPresent };
