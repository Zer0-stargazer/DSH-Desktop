// 验证关于页能打开、关键事实在，且引导页/设置页有入口。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function mustContain(file, needles) {
  const text = fs.readFileSync(file, 'utf8');
  const missing = needles.filter((n) => !text.includes(n));
  if (missing.length) throw new Error(path.basename(file) + ' 缺少: ' + missing.join(', '));
}

app.whenReady().then(async () => {
  const root = __dirname;
  mustContain(path.join(root, '使用说明.md'), ['不是 DeepSeek 官方', 'Zer0', 'gl20070126@gmail.com', '个人开发者']);
  mustContain(path.join(root, 'about.html'), ['非官方', '官方 Discussions', 'Zer0', 'gl20070126@gmail.com', '个人开发者', '初心', '声明', 'Zer0-stargazer/DSH-Desktop/issues']);
  mustContain(path.join(root, 'onboarding.html'), ['id="link-about"', '非官方', 'Zer0', '个人开发者', 'id="pref-auto-update"']);
  mustContain(path.join(root, 'settings.html'), ['id="btn-about"', 'Zer0', 'gl20070126@gmail.com', 'data-pane="kernel"', '个人开发者']);
  mustContain(path.join(root, 'main.js'), ['function createAboutWindow', "desktop:open-about", 'showUpdateProgressWindow', 'resolveNpmProxy']);
  mustContain(path.join(root, 'preload.js'), ['openAbout', 'onUpdateProgress']);
  mustContain(path.join(root, 'update-progress.html'), ['同步官方内核', 'updateProgressNow']);

  const settingsWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await settingsWin.loadFile(path.join(root, 'settings.html'));
  const settingsProbe = await settingsWin.webContents.executeJavaScript(`({
    panes: Array.from(document.querySelectorAll('nav button')).map((b) => b.getAttribute('data-pane')),
    hasProgress: !!document.getElementById('upd-fill'),
    hasShowPane: typeof window.__showPane
  })`);
  settingsWin.close();
  if (!settingsProbe.panes.includes('kernel') || !settingsProbe.panes.includes('sync') || !settingsProbe.hasProgress) {
    throw new Error('设置页未拆开: ' + JSON.stringify(settingsProbe));
  }

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const csp = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    if (/Refused to execute|Content Security Policy/i.test(message)) csp.push(message);
  });
  await win.loadFile(path.join(root, 'about.html'));
  const probe = await win.webContents.executeJavaScript(`({
    title: document.querySelector('h1') && document.querySelector('h1').textContent,
    body: document.body.innerText,
    official: !!document.querySelector('a[href*="deepseek-harness/discussions"]')
  })`);
  const ok = csp.length === 0 && probe && /DSH Desktop/.test(probe.title || '') && /非官方/.test(probe.body || '') && /个人开发者/.test(probe.body || '') && /初心/.test(probe.body || '') && /声明/.test(probe.body || '') && probe.official;
  process.stdout.write(JSON.stringify({ ok, probe, csp }, null, 2) + '\n');
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  process.stdout.write('FAIL ' + String(err && err.message || err) + '\n');
  app.exit(1);
});
