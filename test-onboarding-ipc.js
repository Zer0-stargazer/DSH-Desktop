// 最小复现：验证 onboarding 页脚本是否执行、window.desktop 是否注入、按钮能否打到 IPC。
// 用法：node_modules\electron\dist\electron.exe test-onboarding-ipc.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const results = {
  preloadLogs: [],
  pageLogs: [],
  cspErrors: [],
  allLogs: [],
  probe: null,
  saveKeyCalled: false,
  saveKeyArgLen: 0,
};

ipcMain.handle('desktop:get-state', () => ({ hasKey: false, encryptionAvailable: true }));
ipcMain.handle('desktop:save-key', (_e, key) => {
  results.saveKeyCalled = true;
  results.saveKeyArgLen = String(key || '').length;
  return true;
});
ipcMain.handle('desktop:skip', () => true);
ipcMain.handle('desktop:detect-source', () => ({ home: '', sessionsDir: '', exists: false, count: 0, size: 0 }));
ipcMain.handle('desktop:check-update', () => ({ current: '0.1.0-rc.6', latest: '0.1.0-rc.6', hasUpdate: false }));
ipcMain.handle('desktop:sync-sessions', () => ({ copied: 0, updated: 0, skipped: 0, count: 0, destCount: 0 }));
ipcMain.handle('desktop:sync-official-update', () => ({ current: '0.1.0-rc.6', latest: '0.1.0-rc.6', hasUpdate: false, applied: false }));
ipcMain.handle('desktop:get-prefs', () => ({ autoSyncSessions: true, autoUpdateKernel: true, shareWebHome: false }));
ipcMain.handle('desktop:set-prefs', (_e, p) => p || {});
ipcMain.handle('desktop:relaunch', () => true);
for (const ch of [
  'desktop:kernel-info',
  'desktop:apply-update',
  'desktop:rollback',
  'desktop:import-sessions',
  'desktop:get-dynamics',
  'desktop:export-diagnostic',
  'desktop:open-about',
]) {
  ipcMain.handle(ch, () => ({}));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    results.allLogs.push(message);
    if (/Refused to execute|Content Security Policy/i.test(message)) results.cspErrors.push(message);
    if (String(message).includes('[PRELOAD]')) results.preloadLogs.push(message);
    if (String(message).includes('[ONBOARDING]')) results.pageLogs.push(message);
  });

  await win.loadFile(path.join(__dirname, 'onboarding.html'));
  await new Promise((r) => setTimeout(r, 400));

  results.probe = await win.webContents.executeJavaScript(`({
    desktop: typeof window.desktop,
    hasSaveKey: !!(window.desktop && window.desktop.saveKey),
    status: document.getElementById('status').textContent,
    btnExists: !!document.getElementById('btn-save')
  })`);

  await win.webContents.executeJavaScript(`
    document.getElementById('key').value = 'sk-test-ipc';
    document.getElementById('btn-save').click();
  `);
  await new Promise((r) => setTimeout(r, 400));

  const ok = results.cspErrors.length === 0
    && results.probe
    && results.probe.desktop === 'object'
    && results.probe.hasSaveKey === true
    && results.saveKeyCalled === true
    && results.saveKeyArgLen === 'sk-test-ipc'.length;

  process.stdout.write(JSON.stringify({ ok, ...results }, null, 2) + '\n');
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  process.stderr.write(String(err && err.stack || err) + '\n');
  app.exit(2);
});
