const { wait } = require('./utils');
const { sendHeartbeat } = require('./heartbeat');
const { getBotSettings } = require('./botSettings');

async function solveCloudflareIfPresent(win, botId) {
  console.log('[Cloudflare] Checking...');

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
    console.log('[Cloudflare] Detected. Solving...');

    const botSettings = await getBotSettings(botId);
    const waitBeforeClick = botSettings.cloudflareWaitBeforeClick || 3000;
    const waitAfterClick = botSettings.cloudflareWaitAfterClick || 5000;

    await wait(waitBeforeClick);
    win.focus();
    await runAhkClick();
    await wait(waitAfterClick);

    return await solveCloudflareIfPresent(win, botId);
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

module.exports = { solveCloudflareIfPresent };
