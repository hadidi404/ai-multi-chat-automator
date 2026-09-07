'use strict';

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Desktop shell. Loads the server in-process so there is one process to
// start and one to quit.

// One copy at a time: a second copy holds the same installed files and the
// same browser profile, and the installer cannot replace files another process
// still has open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

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
  // There is no release feed to read in development, only an error.
  if (!app.isPackaged) {
    startApp();
    return;
  }

  // The feed comes from the publish config baked into app-update.yml at build
  // time, so there is nothing to configure here.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    showUpdateWindow();
    tellUpdateWindow(`window.setUpdateDetail(${JSON.stringify(
      `Updating to version ${info.version}\u2026`
    )})`);
  });

  autoUpdater.on('download-progress', (progress) => {
    tellUpdateWindow(
      `window.setUpdateProgress(${progress.percent || 0}, ${progress.transferred || 0}, ${progress.total || 0})`
    );
  });

  // electron-updater has verified the download against the checksum in
  // latest.yml by this point.
  autoUpdater.on('update-downloaded', () => {
    tellUpdateWindow('window.setUpdateDetail("Installing \u2014 the app will restart.")');

    // Marks the quit as ours so the handler below does not intercept it.
    // Everything after this is electron-updater's job: it closes the app,
    // runs the installer, and starts the new version.
    isInstallingUpdate = true;
    autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('update-not-available', startApp);

  autoUpdater.on('error', (err) => {
    // Offline, or no release published. Not a reason to withhold the app.
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
  // During an update the windows close on the way to quitAndInstall, which is
  // what must do the quitting: quitting here instead would end the process
  // before the installer was ever started.
  if (isInstallingUpdate) {
    return;
  }

  app.quit();
});

// Closing the app should take the automation browser with it, or it keeps
// holding the profile.
//
// Started, not awaited, and the quit is never cancelled. Cancelling it to wait
// for the browser meant an unresponsive browser left this process alive with
// no window: invisible to the user, and the reason an installer would later
// report that the app could not be closed.
app.on('before-quit', () => {
  server.closeBrowser().catch(() => {});
});
