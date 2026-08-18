// 短冒烟：打开 splash.html，调用进度钩子，确认 DOM 更新。
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 440,
    height: 220,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'splash.html'));
  const before = await win.webContents.executeJavaScript(
    `({ text: document.getElementById('text').textContent, pct: document.getElementById('pct').textContent, w: document.getElementById('fill').style.width })`
  );
  await win.webContents.executeJavaScript(`window.__setProgress(47, '正在同步网页端会话与外接模型…')`);
  const after = await win.webContents.executeJavaScript(
    `({ text: document.getElementById('text').textContent, pct: document.getElementById('pct').textContent, w: document.getElementById('fill').style.width, hook: typeof window.__setProgress })`
  );
  process.stdout.write('SPLASH ' + JSON.stringify({ before, after }) + '\n');
  const ok = after.hook === 'function' && after.pct === '47%' && after.w === '47%' && after.text.indexOf('同步') >= 0;
  process.stdout.write(ok ? 'SPLASH_PASS\n' : 'SPLASH_FAIL\n');
  app.exit(ok ? 0 : 1);
}).catch((e) => {
  process.stdout.write('SPLASH_FAIL ' + String(e && e.message || e) + '\n');
  app.exit(1);
});
