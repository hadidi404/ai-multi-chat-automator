'use strict';

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Desktop shell. Loads the server in-process so there is one process to
// start and one to quit.

// Must be set before the server is loaded: it decides where the browser
// profile, saved questions and Drive credentials live. Inside the installed
// app the code is read-only, so none of them can sit next to it.
// One copy at a time. A second instance would hold the same installed files
// and the same browser profile, and the installer cannot replace files another
// process still has open — which is how an update fails to uninstall.
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
      `Updating to version ${info.version}…`
    )})`);
  });

  autoUpdater.on('download-progress', (progress) => {
    tellUpdateWindow(
      `window.setUpdateProgress(${progress.percent || 0}, ${progress.transferred || 0}, ${progress.total || 0})`
    );
  });

  autoUpdater.on('update-downloaded', async () => {
    tellUpdateWindow('window.setUpdateDetail("Installing — the app will restart.")');

    // The quit handler below must not intercept this one: cancelling the quit
    // that quitAndInstall depends on would leave the installer never running.
    isInstallingUpdate = true;

    // The installer starts by uninstalling this version, which fails while
    // anything still holds its files, so the automation browser is closed
    // first. Capped: closing a browser that has stopped responding can hang,
    // and waiting forever is worse than leaving it to the quit.
    await Promise.race([
      server.closeBrowser().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);

    // Windows are left to quitAndInstall, which closes them itself. Doing it
    // by hand here is what previously left none open, letting the app quit
    // before the installer had started.
    //
    // isSilent stays false: a silent NSIS run does not wait for this process to
    // release its files, which is exactly how the uninstall step fails.
    // oneClick already reduces the installer to a progress bar, so there is no
    // wizard either way. isForceRunAfter reopens the app when it finishes.
    autoUpdater.quitAndInstall(false, true);
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
  // During an update the windows close on the way to quitAndInstall, which is
  // what must do the quitting: quitting here instead would end the process
  // before the installer was ever started.
  if (isInstallingUpdate) {
    return;
  }

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
