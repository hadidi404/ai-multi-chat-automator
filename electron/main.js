'use strict';

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Desktop shell. Loads the server in-process so there is one process to
// start and one to quit.

// Must be set before the server is loaded: it decides where the browser
// profile, saved questions and Drive credentials live. Inside the installed
// app the code is read-only, so none of them can sit next to it.
process.env.AI_MULTI_CHAT_DATA = app.getPath('userData');

const server = require('../server');

let mainWindow = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 760,
    title: 'AI Multi-Chat',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      // The page is our own local UI, but it has no need for Node, so it does
      // not get it.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Nothing is worth showing until the page has painted; an empty white frame
  // on launch reads as a hang.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Google's sign-in and the AI sites belong in a real browser, not in here.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.loadURL(url);
}

// Updates. A new version must be installed before the app can be used; a
// failed check never blocks, so an offline user is not locked out.

let updateWindow = null;
let isInstallingUpdate = false;

function showUpdateWindow() {
  updateWindow = new BrowserWindow({
    width: 460,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Updating AI Multi-Chat',
    backgroundColor: '#f6f7f9',
  });

  updateWindow.setMenuBarVisibility(false);
  updateWindow.loadFile(path.join(__dirname, 'updating.html'));
  return updateWindow;
}

/** Pushes a value into the update window, ignoring a window already gone. */
function tellUpdateWindow(expression) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.webContents.executeJavaScript(expression).catch(() => {});
  }
}

function startApp() {
  try {
    server.listen(server.DEFAULT_PORT, 10, (url) => {
      createWindow(url);

      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.close();
        updateWindow = null;
      }
    });
  } catch (err) {
    dialog.showErrorBox('AI Multi-Chat could not start', String(err && err.message ? err.message : err));
    app.quit();
  }
}

function beginUpdateCheck() {
  // The updater has no release to read in development, and would only ever
  // report an error. Start straight away instead.
  if (!app.isPackaged) {
    startApp();
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    showUpdateWindow();
    tellUpdateWindow(`window.setUpdateDetail(${JSON.stringify(
      `Version ${info.version} is required. Downloading it now…`
    )})`);
  });

  autoUpdater.on('download-progress', (progress) => {
    tellUpdateWindow(
      `window.setUpdateProgress(${progress.percent || 0}, ${progress.transferred || 0}, ${progress.total || 0})`
    );
  });

  autoUpdater.on('update-downloaded', () => {
    tellUpdateWindow('window.setUpdateDetail("Installing — the app will restart.")');
    // The quit handler below must not intercept this one: cancelling the quit
    // that quitAndInstall depends on would leave the installer never running.
    isInstallingUpdate = true;
    // isSilent = false so the installer is visible; isForceRunAfter = true so
    // the user lands back in the app rather than having to find it again.
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 800);
  });

  autoUpdater.on('update-not-available', startApp);

  autoUpdater.on('error', (err) => {
    // Could not reach the release feed. Not a reason to withhold the app.
    console.error(`Update check failed: ${err && err.message ? err.message : err}`);
    startApp();
  });

  autoUpdater.checkForUpdates().catch(startApp);
}

app.whenReady().then(() => {
  // "Jump to question" raises the automation browser. Windows only lets the
  // process that currently holds the foreground give it away, and that is this
  // window — so it has to stand down before the browser can come forward.
  // Without this the browser gets the request and stays behind us.
  server.setYieldForeground(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.blur();
    }
  });

  beginUpdateCheck();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Closing the window must take the automation browser with it, or it keeps
// holding the profile and the next launch cannot use it.
app.on('before-quit', async (event) => {
  // Never stand in the way of the installer; there is no run to tidy up
  // anyway, since the app has not started yet when an update is applied.
  if (app.isQuitting || isInstallingUpdate) {
    return;
  }

  event.preventDefault();
  app.isQuitting = true;

  await server.closeBrowser().catch(() => {});
  app.quit();
});
