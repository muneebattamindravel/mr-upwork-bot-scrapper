const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

async function createBrowserWindow(session, screen) {

  const ses = session.defaultSession;

  const cookiePath = path.join(__dirname, '../upwork_cookies.json');
  const fileContent = fs.readFileSync(cookiePath, 'utf-8').replace(/^\uFEFF/, '');

  try {
    const cookies = JSON.parse(fileContent);

    for (const c of cookies) {
      try {
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
      } catch (err) {
        console.error(`❌ Error setting cookie: ${c.name}`, err.message);
      }
    }

    log('[Debug] Cookies injected.');
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

// async function createBrowserWindowNoLogin(session, screen) {

//   const ses = session.defaultSession;

//   const { width, height } = screen.getPrimaryDisplay().workAreaSize;

//   const win = new BrowserWindow({
//     x: 0,
//     y: 0,
//     width: Math.floor(width / 2),
//     height,
//     webPreferences: {
//       session: ses,
//       preload: path.join(__dirname, '../preload.js'),
//       nodeIntegration: false,
//       contextIsolation: true
//     }
//   });

//   return win;
// }

async function createBrowserWindowNoLogin(session, screen) {

  // 🔒 Create incognito (non-persistent) session
  const incognitoSession = session.fromPartition('incognito');

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;;

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: Math.floor(width / 2),
    height,
    webPreferences: {
      session: incognitoSession,
      preload: path.join(__dirname, '../preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  await incognitoSession.clearCache();
  await incognitoSession.clearStorageData();

  return win;
}

module.exports = { createBrowserWindow, createBrowserWindowNoLogin };
