const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

async function createBrowserWindow(session, screen) {

  const ses = session.defaultSession;

  const cookiePath = path.join(__dirname, '../upwork_cookies.json');
  const fileContent = fs.readFileSync(cookiePath, 'utf-8').replace(/^\uFEFF/, '');

  try {
    const cookies = JSON.parse(fileContent);
    console.log(`cookies found`)

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

    console.log('[Debug] Cookies injected.');
  } catch (err) {
    console.error('❌ Error parsing cookies JSON:', err.message);
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: Math.floor(width / 2),
    height,
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, '../preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  return win;
}

module.exports = { createBrowserWindow };
