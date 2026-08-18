// DSH Desktop — 主进程
// 职责：找到 Node，拉起 `dsh web`（隔离的 DSH_HOME），等端口就绪后开窗口，
//       首次运行时弹出 API Key 引导页。完全不改 DSH 内核，只做"薄壳"。

const { app, BrowserWindow, BrowserView, ipcMain, safeStorage, shell, dialog, Menu, net: electronNet, Tray, nativeImage, nativeTheme, WebContentsView, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const {
  mergeWorkspaceIndex,
  mergeSessionProjcache,
  mergeSettingsModels,
  mergeCredentials,
  applyCredentialEnv,
  sameHome,
  resolveDshHome,
} = require('./sync-from-web');

const PRODUCT_NAME = 'DSH Desktop';
const PREFERRED_PORT = 3080;
const READY_TIMEOUT_MS = 120 * 1000;
const COLD_READY_TIMEOUT_MS = 180 * 1000;
const TESTED_DSH_VERSION = '0.1.0-rc.6';
const DSH_PACKAGE = '@deepseek-ai/dsh';

app.setName(PRODUCT_NAME);
nativeTheme.themeSource = 'system';
// 允许覆盖 userData（配置/DSH_HOME/日志都在这下面）：本地测试指向工作区，避免沙箱拦 %APPDATA%
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}

let dshChild = null;
let mainWindow = null;
let onboardingWindow = null;
let splashWindow = null;
let splashReadyPromise = null;
let resolvedPort = null;
let quitting = false;
let tray = null;
let justAppliedUpdate = false;

// ---------- 日志 ----------
function logPath() {
  return path.join(app.getPath('userData'), 'dsh-desktop.log');
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), line);
  } catch {}
  if (process.env.DSH_DESKTOP_DEBUG) {
    try { process.stdout.write(line); } catch {}
  }
}

// ---------- 配置 / API Key ----------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}
function getApiKey() {
  const cfg = readConfig();
  if (cfg.keyEnc) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(cfg.keyEnc, 'base64'));
      }
      log('getApiKey: encryption unavailable');
    } catch (e) {
      log('getApiKey: decrypt failed:', (e && e.message) || e);
    }
  }
  return typeof cfg.keyPlain === 'string' ? cfg.keyPlain : '';
}
function setApiKey(key) {
  const cfg = readConfig();
  const value = String(key || '').trim();
  if (safeStorage.isEncryptionAvailable()) {
    if (value) cfg.keyEnc = safeStorage.encryptString(value).toString('base64');
    else delete cfg.keyEnc;
    delete cfg.keyPlain;
  } else {
    if (value) cfg.keyPlain = value;
    else delete cfg.keyPlain;
    delete cfg.keyEnc;
  }
  writeConfig(cfg);
}

// ---------- 路径 ----------
function isolatedDshHome() {
  return path.join(app.getPath('userData'), 'dsh-home');
}
function dshHome() {
  return resolveDshHome(isolatedDshHome(), defaultSourceHome(), prefs().shareWebHome);
}
function dshBin() {
  return path.join(resolveKernelDir(), 'lib', 'bin.js');
}
function resolveNodeExe() {
  const candidates = [
    process.env.DSH_DESKTOP_NODE,
    path.join(__dirname, 'vendor', 'node', 'node.exe'),          // 开发：项目内自带 Node
    path.join(process.resourcesPath || '', 'node', 'node.exe'),  // 打包：extraResources 里的 Node
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node'; // 回退：系统 PATH 上的 Node
}

// ---------- 内核管理（P1：内核级更新 + 版本守护 + 回滚） ----------
// 内核有两处：自带（随应用打包，只读、永远可用）和「用户已更新」（装在可写的
// userData/kernel 下）。默认用自带；点更新后切到已更新，回滚则切回自带。
function kernelRoot() {
  return path.join(app.getPath('userData'), 'kernel');
}
function bundledKernelDir() {
  return path.join(__dirname, 'node_modules', DSH_PACKAGE);
}
function installedKernelDir() {
  return path.join(kernelRoot(), 'node_modules', DSH_PACKAGE);
}
function resolveKernelDir() {
  const cfg = readConfig();
  const installed = installedKernelDir();
  if (cfg.kernel === 'installed' && fs.existsSync(path.join(installed, 'package.json'))) {
    return installed;
  }
  return bundledKernelDir();
}
function kernelVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.version || '';
  } catch {
    return '';
  }
}
function npmCli() {
  const exe = resolveNodeExe();
  if (exe === 'node') return '';
  return path.join(path.dirname(exe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}
// 解析 x.y.z[-rc.N] 供比较
function parseVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  const pre = m[4] || '';
  const rc = pre.match(/^rc\.(\d+)/i);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre, rc: rc ? +rc[1] : -1 };
}
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  const ra = pa.pre === '' ? Infinity : pa.rc;
  const rb = pb.pre === '' ? Infinity : pb.rc;
  return ra === rb ? 0 : ra > rb ? 1 : -1;
}
function checkCompatibility(version) {
  const tested = parseVersion(TESTED_DSH_VERSION);
  const cur = parseVersion(version);
  if (!cur || !tested) return { ok: false, level: 'unknown', reason: '无法识别版本号' };
  if (cur.major !== tested.major) return { ok: false, level: 'major', reason: `主版本不一致（已测 ${TESTED_DSH_VERSION}）` };
  if (cur.minor !== tested.minor) return { ok: false, level: 'minor', reason: `次版本不一致（已测 ${TESTED_DSH_VERSION}）` };
  return { ok: true, level: 'ok', reason: '' };
}
function kernelInfo() {
  const dir = resolveKernelDir();
  const version = kernelVersion(dir);
  const compat = checkCompatibility(version);
  return {
    version,
    source: dir === installedKernelDir() ? 'installed' : 'bundled',
    testedVersion: TESTED_DSH_VERSION,
    compatible: compat.ok,
    compatLevel: compat.level,
    compatReason: compat.reason,
    hasInstalledKernel: fs.existsSync(path.join(installedKernelDir(), 'package.json')),
  };
}
function kernelStamp() {
  const k = kernelInfo();
  return String(k.version || '') + '@' + String(k.source || '');
}
function isColdKernelBoot() {
  return readConfig().lastWarmKernel !== kernelStamp();
}
function markKernelWarm() {
  const cfg = readConfig();
  cfg.lastWarmKernel = kernelStamp();
  writeConfig(cfg);
}
function compileCacheDir() {
  return path.join(app.getPath('userData'), 'node-compile-cache');
}
function npmCacheDir() {
  return path.join(app.getPath('userData'), 'npm-cache');
}
function formatElapsed(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}
function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      try { s.destroy(); } catch {}
      resolve(ok);
    };
    s.setTimeout(timeoutMs || 400, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function normalizeProxy(raw) {
  const s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s.replace(/^PROXY\s+/i, '');
}
async function resolveNpmProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (envProxy) return normalizeProxy(envProxy);
  if (await probePort('127.0.0.1', 7897)) return 'http://127.0.0.1:7897';
  for (const p of [7890, 10809, 10808, 1080]) {
    if (await probePort('127.0.0.1', p)) return 'http://127.0.0.1:' + p;
  }
  try {
    const spec = await session.defaultSession.resolveProxy('https://registry.npmjs.org/');
    const m = String(spec || '').match(/PROXY\s+([^\s;]+)/i);
    if (m) return normalizeProxy(m[1]);
  } catch (e) {
    log('resolveProxy failed:', (e && e.message) || e);
  }
  return '';
}

let lastUpdateProgress = { phase: 'idle', percent: 0, text: '', proxy: '', error: '' };
let updateBusy = false;
let updateWindow = null;

function emitUpdateProgress(partial) {
  lastUpdateProgress = Object.assign({}, lastUpdateProgress, partial, { at: Date.now() });
  log('update-progress', lastUpdateProgress.percent + '%', lastUpdateProgress.phase, lastUpdateProgress.text);
  const payload = lastUpdateProgress;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send('desktop:update-progress', payload); } catch {}
    }
  }
}
function showUpdateProgressWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.show();
    updateWindow.focus();
    return updateWindow;
  }
  updateWindow = new BrowserWindow({
    width: 480,
    height: 280,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: '同步官方内核',
    icon: windowIcon(),
    backgroundColor: chromePalette().shell,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  updateWindow.setMenuBarVisibility(false);
  updateWindow.loadFile(path.join(__dirname, 'update-progress.html'));
  updateWindow.on('closed', () => { updateWindow = null; });
  return updateWindow;
}

// 用自带 npm 跑一条命令。走已探测到的代理（Clash / 系统代理），进度回传给窗口。
function runNpm(args, cwd, opts) {
  const onProgress = opts && opts.onProgress;
  const timeoutMs = (opts && opts.timeoutMs) || 480000;
  const proxy = (opts && opts.proxy) || '';
  return new Promise((resolve) => {
    const nodeExe = resolveNodeExe();
    const cli = npmCli();
    if (!cli || !fs.existsSync(cli)) {
      return resolve({ code: -1, stdout: '', stderr: '安装包不完整，请重新下载解压包' });
    }
    log('npm', args.join(' '), 'cwd=', cwd || '(default)', 'proxy=', proxy || '(none)');
    try { fs.mkdirSync(npmCacheDir(), { recursive: true }); } catch {}
    const env = {
      ...process.env,
      CI: '1',
      npm_config_cache: npmCacheDir(),
      npm_config_progress: 'true',
      npm_config_loglevel: 'http',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_fetch_retries: '3',
      npm_config_fetch_retry_mintimeout: '20000',
      npm_config_fetch_timeout: '120000',
    };
    if (proxy) {
      env.HTTP_PROXY = proxy;
      env.HTTPS_PROXY = proxy;
      env.http_proxy = proxy;
      env.https_proxy = proxy;
      env.npm_config_proxy = proxy;
      env.npm_config_https_proxy = proxy;
    }
    const child = spawn(nodeExe, [cli, ...args], {
      cwd: cwd || app.getPath('userData'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let pct = (opts && opts.startPercent) || 24;
    let phase = 'download';
    let lastText = '正在从 npm 拉取依赖…';
    const startedAt = Date.now();
    const installing = args.some((a) => a === 'install' || String(a).startsWith('install'));
    const hint = installing
      ? '依赖很多，进度到 90% 附近还会继续下，不是卡住。请留着这个窗口。'
      : '';
    const emit = (nextPhase, nextText, cap) => {
      if (nextPhase) phase = nextPhase;
      if (typeof cap === 'number' && pct < cap) pct = Math.min(cap, pct + (installing ? 0.7 : 2));
      if (nextText) lastText = nextText;
      if (typeof onProgress === 'function') {
        onProgress({
          phase,
          percent: Math.round(pct),
          text: lastText + '（已用 ' + formatElapsed(Date.now() - startedAt) + '）',
          hint,
        });
      }
    };
    const take = (kind) => (d) => {
      const s = String(d);
      if (kind === 'out') out += s;
      else err += s;
      if (out.length > 80000) out = out.slice(-40000);
      if (err.length > 80000) err = err.slice(-40000);
      const lines = s.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let nextPhase = phase;
        let text = t.slice(0, 120);
        let cap = installing ? 88 : 90;
        if (/idealTree|resolv/i.test(t)) {
          nextPhase = 'resolve';
          text = '正在解析依赖…';
          cap = 36;
        } else if (/reify|extract|tarball/i.test(t)) {
          nextPhase = 'extract';
          text = '正在解压内核…';
          cap = 94;
        } else if (/http fetch|GET |POST /i.test(t)) {
          nextPhase = 'download';
          const name = (() => {
            const m = t.match(/registry\.npmjs\.org\/(@?[^/\s]+)/i);
            if (!m) return '';
            try { return decodeURIComponent(m[1]); } catch { return m[1]; }
          })();
          text = name ? ('正在下载 ' + name) : ('正在下载：' + t.replace(/^npm\s+/i, '').slice(0, 80));
          cap = 88;
        } else if (/added \d+/i.test(t)) {
          nextPhase = 'install';
          text = t;
          cap = 97;
        }
        emit(nextPhase, text, cap);
      }
    };
    const idle = setInterval(() => {
      if (!installing || pct >= 97) return;
      pct = Math.min(97, pct + 0.35);
      if (typeof onProgress === 'function') {
        onProgress({
          phase,
          percent: Math.round(pct),
          text: lastText.replace(/（已用[^）]*）$/, '') + '（已用 ' + formatElapsed(Date.now() - startedAt) + '）',
          hint,
        });
      }
    }, 1000);
    const timer = setTimeout(() => {
      clearInterval(idle);
      try { child.kill(); } catch {}
      resolve({ code: -1, stdout: out, stderr: (err || '') + '\n更新超过 ' + Math.round(timeoutMs / 1000 / 60) + ' 分钟。可能是网络较慢或代理未开启。可在设置里重试；失败后 6 小时内不会自动再试。' });
    }, timeoutMs);
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    child.on('error', (e) => {
      clearTimeout(timer);
      clearInterval(idle);
      resolve({ code: -1, stdout: '', stderr: String(e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(idle);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}
async function checkUpdate() {
  const info = kernelInfo();
  emitUpdateProgress({ phase: 'check', percent: 8, text: '正在查询 npm 最新版本…', error: '' });
  try {
    const r = await fetchJson('https://registry.npmjs.org/@deepseek-ai%2fdsh');
    const latest = r.json['dist-tags'] && r.json['dist-tags'].latest;
    if (!latest) throw new Error('npm 未返回 latest');
    const hasUpdate = compareVersions(latest, info.version) > 0;
    emitUpdateProgress({
      phase: 'check',
      percent: 20,
      text: hasUpdate ? ('发现 ' + latest + '（当前 ' + info.version + '）') : ('已是最新 ' + info.version),
    });
    return { current: info.version, latest, hasUpdate };
  } catch (e) {
    log('checkUpdate via net failed, fallback npm:', (e && e.message) || e);
    emitUpdateProgress({ phase: 'check', percent: 12, text: '直连失败，改走 npm…' });
    const proxy = await resolveNpmProxy();
    emitUpdateProgress({ proxy });
    const r = await runNpm(['view', DSH_PACKAGE, 'version'], app.getPath('userData'), {
      proxy,
      timeoutMs: 90000,
      startPercent: 12,
      onProgress: (p) => emitUpdateProgress(p),
    });
    if (r.code !== 0) {
      throw new Error('检查更新失败：' + (String(r.stderr || r.stdout || '').trim() || '网络不可达') + (proxy ? '' : '。未检测到代理，若用了 Clash 请开系统代理或 7897 端口'));
    }
    const latest = String(r.stdout).trim().split(/\s+/)[0];
    const hasUpdate = compareVersions(latest, info.version) > 0;
    return { current: info.version, latest, hasUpdate };
  }
}
async function applyUpdate() {
  if (updateBusy) throw new Error('正在更新，请等当前这次结束');
  updateBusy = true;
  const root = kernelRoot();
  try {
    showUpdateProgressWindow();
    const proxy = await resolveNpmProxy();
    emitUpdateProgress({
      phase: 'prepare',
      percent: 6,
      text: (proxy ? ('已走代理 ' + proxy) : '未检测到代理，直连 npm') + '。内核依赖较大，常要 5–10 分钟',
      proxy,
      hint: '进度到 90% 附近还会继续下，不是卡住。请留着这个窗口。',
      error: '',
    });
    fs.mkdirSync(root, { recursive: true });
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'dsh-kernel', private: true, version: '0.0.0' }, null, 2) + '\n');
    }
    const oldDir = installedKernelDir();
    const backupDir = path.join(kernelRoot(), 'node_modules.backup', DSH_PACKAGE);
    if (fs.existsSync(oldDir)) {
      emitUpdateProgress({ phase: 'prepare', percent: 14, text: '正在备份当前内核…' });
      fs.mkdirSync(path.dirname(backupDir), { recursive: true });
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.renameSync(oldDir, backupDir);
    }
    log('applyUpdate: install', DSH_PACKAGE + '@latest', 'into', root, 'proxy=', proxy || '(none)');
    emitUpdateProgress({
      phase: 'download',
      percent: 22,
      text: '正在从 npm 拉取 ' + DSH_PACKAGE + '@latest…',
      hint: '进度到 90% 附近还会继续下，不是卡住。请留着这个窗口。',
    });
    const r = await runNpm(['install', DSH_PACKAGE + '@latest', '--save', '--omit=dev', '--no-audit', '--no-fund'], root, {
      proxy,
      timeoutMs: 480000,
      startPercent: 22,
      onProgress: (p) => emitUpdateProgress(p),
    });
    if (r.code !== 0) {
      if (fs.existsSync(backupDir) && !fs.existsSync(oldDir)) {
        fs.mkdirSync(path.dirname(oldDir), { recursive: true });
        fs.renameSync(backupDir, oldDir);
      }
      const hint = proxy ? '' : '。未检测到代理；Clash 默认试的是 127.0.0.1:7897';
      throw new Error((String(r.stderr || r.stdout || '').trim() || ('npm 退出码 ' + r.code)) + hint);
    }
    const newVer = kernelVersion(installedKernelDir());
    if (!newVer) throw new Error('安装结束但读不到新版本号');
    const cfg = readConfig();
    cfg.kernel = 'installed';
    cfg.lastUpdateOk = true;
    cfg.lastUpdateAttempt = new Date().toISOString();
    cfg.lastUpdateError = '';
    writeConfig(cfg);
    emitUpdateProgress({
      phase: 'done',
      percent: 100,
      text: '已更新到 ' + newVer + '。重启后第一次打开会和首次安装一样慢，等一两分钟正常',
      hint: '',
      error: '',
    });
    log('applyUpdate: 成功，版本', newVer);
    return { version: newVer };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const cfg = readConfig();
    cfg.lastUpdateOk = false;
    cfg.lastUpdateAttempt = new Date().toISOString();
    cfg.lastUpdateError = msg.slice(0, 500);
    writeConfig(cfg);
    emitUpdateProgress({ phase: 'error', percent: lastUpdateProgress.percent || 20, text: '更新失败', error: msg });
    throw new Error('内核更新失败：' + msg);
  } finally {
    updateBusy = false;
  }
}
function rollback() {
  const cfg = readConfig();
  cfg.kernel = 'bundled';
  writeConfig(cfg);
  log('rollback: kernel -> bundled');
  return kernelInfo();
}

// ---------- 会话同步（网页版 ~/.dsh → 桌面端 DSH_HOME，增量合并） ----------
function defaultSourceHome() {
  return path.join(os.homedir(), '.dsh');
}
function isSessionFile(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.sqlite') || n.endsWith('.db') || n.endsWith('.lock')) return false;
  return n.endsWith('.jsonl') || n.endsWith('.jsonl.zstd') || n.endsWith('.json');
}
function copyDirContents(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirContents(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function countSessions(dir) {
  let count = 0;
  let size = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isSessionFile(e.name)) {
        count++;
        try { size += fs.statSync(p).size; } catch {}
      }
    }
  };
  walk(dir);
  return { count, size };
}
function detectSource(home) {
  const h = home && String(home).trim() ? String(home).trim() : defaultSourceHome();
  const sessionsDir = path.join(h, 'sessions');
  const exists = fs.existsSync(sessionsDir);
  const stats = exists ? countSessions(sessionsDir) : { count: 0, size: 0 };
  return { home: h, sessionsDir, exists, ...stats };
}
function syncSessionFiles(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      syncSessionFiles(s, d, stats);
      continue;
    }
    if (!e.isFile() || !isSessionFile(e.name)) {
      stats.skipped += 1;
      continue;
    }
    let destStat = null;
    try { destStat = fs.statSync(d); } catch {}
    const srcStat = fs.statSync(s);
    if (!destStat) {
      fs.copyFileSync(s, d);
      stats.copied += 1;
    } else if (srcStat.mtimeMs > destStat.mtimeMs + 500) {
      fs.copyFileSync(s, d);
      stats.updated += 1;
    } else {
      stats.skipped += 1;
    }
  }
}
function syncSessions(sourceHome) {
  const srcHome = sourceHome && String(sourceHome).trim() ? String(sourceHome).trim() : defaultSourceHome();
  const destHome = dshHome();
  if (sameHome(srcHome, destHome)) {
    const after = countSessions(path.join(destHome, 'sessions'));
    log('sync-sessions: skipped same-home', destHome);
    return {
      copied: 0,
      updated: 0,
      skipped: 0,
      count: 0,
      destCount: after.count,
      size: after.size,
      source: srcHome,
      destination: destHome,
      skippedReason: 'same-home',
    };
  }
  const src = path.join(srcHome, 'sessions');
  if (!fs.existsSync(src)) throw new Error('未找到源会话目录：' + src);
  const dst = path.join(destHome, 'sessions');
  const stats = { copied: 0, updated: 0, skipped: 0 };
  syncSessionFiles(src, dst, stats);
  const workspace = mergeWorkspaceIndex(srcHome, destHome);
  const projcache = mergeSessionProjcache(srcHome, destHome);
  const models = mergeSettingsModels(srcHome, destHome);
  const credentials = mergeCredentials(srcHome, destHome);
  const after = countSessions(dst);
  const cfg = readConfig();
  cfg.lastSessionSync = new Date().toISOString();
  cfg.lastSessionSource = srcHome;
  writeConfig(cfg);
  log('sync-sessions:', JSON.stringify({
    ...stats,
    destCount: after.count,
    dst,
    workspace,
    projcache,
    models: models && {
      merged: models.merged,
      providersAdded: models.providersAdded || [],
      providersUpdated: models.providersUpdated || [],
      defaultModelSynced: !!models.defaultModelSynced,
      providerCount: models.providerCount || 0,
    },
    credentials: credentials && {
      merged: credentials.merged,
      keysAdded: credentials.keysAdded || [],
      keyCount: credentials.keyCount || 0,
    },
  }));
  return {
    ...stats,
    count: stats.copied + stats.updated,
    destCount: after.count,
    size: after.size,
    source: srcHome,
    destination: dst,
    lastSync: cfg.lastSessionSync,
    workspace,
    projcache,
    models,
    credentials: credentials && {
      merged: credentials.merged,
      keysAdded: credentials.keysAdded || [],
      keyCount: credentials.keyCount || 0,
    },
  };
}
function importSessions(sourceHome) {
  return syncSessions(sourceHome);
}
async function syncOfficialUpdate() {
  const checked = await checkUpdate();
  if (!checked.hasUpdate) return { ...checked, applied: false };
  const applied = await applyUpdate();
  justAppliedUpdate = true;
  return { ...checked, applied: true, version: applied.version };
}

// ---------- 官方动态（P3：npm 最新版 + GitHub Releases + 社区入口） ----------
const COMMUNITY_LINKS = [
  { group: '官方', name: '官方仓库 deepseek-ai/deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness', official: true },
  { group: '官方', name: '官方 Discussions（问题与建议主场）', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions', official: true },
  { group: '官方', name: '发帖须知（官方置顶）', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1797', official: true },
  { group: '官方', name: '官方/民间交流群入口', url: 'https://github.com/deepseek-ai/deepseek-harness/discussions/1728', official: true },
  { group: '官方', name: '官方介绍页 DeepSeek Harness', url: 'https://www.deepseek.com/harness/en/', official: true },
  { group: '官方', name: 'npm 包 @deepseek-ai/dsh', url: 'https://www.npmjs.com/package/@deepseek-ai/dsh', official: true },
  { group: '评测与讨论', name: '知乎：如何评价 DeepSeek Harness', url: 'https://www.zhihu.com/question/2071335529577239335', official: false },
  { group: '评测与讨论', name: '知乎：如何看待 DeepSeek Harness 发布', url: 'https://www.zhihu.com/question/2071331484284220938', official: false },
  { group: '评测与讨论', name: '量子位：深度体验 DeepSeek Harness', url: 'https://www.qbitai.com/2026/08/472208.html', official: false },
  { group: '评测与讨论', name: '知乎专栏：安装初体验', url: 'https://zhuanlan.zhihu.com/p/2071375794388186083', official: false },
  { group: '评测与讨论', name: 'LINUX DO：DSH 相关讨论', url: 'https://linux.do/search?q=DeepSeek%20Harness', official: false },
  { group: '本窗口', name: 'DSH Desktop 仓库与版本', url: 'https://github.com/Zer0-stargazer/DSH-Desktop', official: false },
  { group: '本窗口', name: '窗口问题与建议（Issues）', url: 'https://github.com/Zer0-stargazer/DSH-Desktop/issues', official: false },
  { group: '本窗口', name: 'DSH Desktop Releases', url: 'https://github.com/Zer0-stargazer/DSH-Desktop/releases', official: false },
  { group: '社区目录', name: 'awesome-dsh-plugin（插件精选）', url: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin', official: false },
  { group: '社区目录', name: 'dsh-handbook（从 0 到 1 手册）', url: 'https://github.com/Electricitysheep/dsh-handbook', official: false },
  { group: '社区目录', name: 'dshfind（原理与插件市场）', url: 'https://github.com/hikariming/dshfind', official: false },
  { group: '社区目录', name: 'Oh-My-DSH（插件聚合）', url: 'https://github.com/like-study1/Oh-My-DSH', official: false },
  { group: '社区目录', name: 'GitHub topic: dsh-plugin', url: 'https://github.com/topics/dsh-plugin', official: false },
];
// 用 Electron net（Chromium 网络栈，自动尊重系统代理）抓 JSON，失败则 reject
function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = electronNet.request({ method: 'GET', url });
    let body = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { req.abort(); } catch {}
      reject(new Error('请求超时'));
    }, timeoutMs);
    req.on('response', (res) => {
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (e) {
          reject(new Error('响应不是合法 JSON'));
        }
      });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}
async function getDynamics() {
  const result = {
    currentVersion: kernelInfo().version,
    npmLatest: null,
    hasUpdate: false,
    npmError: null,
    githubReleases: [],
    githubError: null,
    communityLinks: COMMUNITY_LINKS,
  };
  try {
    const r = await fetchJson('https://registry.npmjs.org/@deepseek-ai%2fdsh');
    result.npmLatest = r.json['dist-tags'] && r.json['dist-tags'].latest;
    result.hasUpdate = result.npmLatest && compareVersions(result.npmLatest, result.currentVersion) > 0;
  } catch (e) {
    result.npmError = String((e && e.message) || e);
  }
  try {
    const r = await fetchJson('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=5');
    result.githubReleases = (Array.isArray(r.json) ? r.json : []).map((x) => ({
      name: x.name || x.tag_name,
      tag: x.tag_name,
      date: x.published_at,
      url: x.html_url,
    }));
  } catch (e) {
    result.githubError = String((e && e.message) || e);
  }
  return result;
}

// ---------- 端口 ----------
function getFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(getFreePort(preferred + 1)));
    srv.listen(preferred, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------- dsh 生命周期 ----------
function startDsh(port) {
  const nodeExe = resolveNodeExe();
  const bin = dshBin();
  const home = dshHome();
  fs.mkdirSync(home, { recursive: true });

  try { fs.mkdirSync(compileCacheDir(), { recursive: true }); } catch {}
  const env = { ...process.env, DSH_HOME: home, NODE_COMPILE_CACHE: compileCacheDir() };
  const key = getApiKey();
  const share = prefs().shareWebHome;
  let injected = [];
  if (share) {
    // 共用网页端目录时以 ~/.dsh 凭据为准，不拿壳里的 Key 覆盖
    injected = applyCredentialEnv(env, home);
    if (key && !env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = key;
  } else {
    if (key) env.DEEPSEEK_API_KEY = key;
    injected = applyCredentialEnv(env, home);
  }

  const args = [bin, 'web', '--host', '127.0.0.1', '--port', String(port)];
  log('launch:', JSON.stringify(nodeExe), args.join(' '));
  log('DSH_HOME =', home, share ? '(share-web)' : '(isolated)');
  log('key present =', key.length > 0);
  if (injected.length) log('credential env injected =', injected.join(','));

  dshChild = spawn(nodeExe, args, {
    env,
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshChild.stdout.on('data', (d) => log('[dsh:out]', String(d).trimEnd()));
  dshChild.stderr.on('data', (d) => log('[dsh:err]', String(d).trimEnd()));
  dshChild.on('error', (e) => log('dsh spawn error:', e));
  dshChild.on('exit', (code, signal) => {
    log('dsh exited: code=', code, 'signal=', signal);
    dshChild = null;
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dsh-exit', { code });
    }
  });
}

function stopDsh() {
  if (!dshChild) return;
  const child = dshChild;
  dshChild = null;
  try {
    child.kill();
  } catch {}
  // Windows 下没有 POSIX 信号，直接终止即可；dsh 的落盘是原子写，风险可控。
}

function waitForReady(port, timeoutMs, onProgress, expectMs) {
  const started = Date.now();
  const expect = Math.max(5000, Number(expectMs) || timeoutMs);
  return new Promise((resolve, reject) => {
    const tick = () => {
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) {
        return reject(new Error(`dsh web 在 ${Math.round(timeoutMs / 1000)}s 内未就绪（端口 ${port}）`));
      }
      if (typeof onProgress === 'function') {
        try { onProgress(Math.min(0.92, elapsed / expect), elapsed); } catch {}
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode < 500) return resolve();
        setTimeout(tick, 500);
      });
      req.on('error', () => setTimeout(tick, 500));
      req.on('timeout', () => {
        req.destroy();
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

// ---------- 启动进度窗 ----------
function showSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    return splashReadyPromise || Promise.resolve();
  }
  splashWindow = new BrowserWindow({
    width: 460,
    height: 268,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: true,
    title: PRODUCT_NAME,
    icon: windowIcon(),
    backgroundColor: chromePalette().shell,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  splashReadyPromise = new Promise((resolve) => {
    const done = () => resolve();
    splashWindow.webContents.once('did-finish-load', done);
    splashWindow.once('ready-to-show', done);
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
    splashReadyPromise = null;
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  return splashReadyPromise;
}
function setBootProgress(percent, text, hint) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const label = String(text || '');
  const extra = hint === undefined ? '' : String(hint || '');
  log('boot-progress', p + '%', label);
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const js = `window.__setProgress && window.__setProgress(${p}, ${JSON.stringify(label)}, ${JSON.stringify(extra)})`;
  splashWindow.webContents.executeJavaScript(js).catch(() => {});
}
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch {}
  }
  splashWindow = null;
  splashReadyPromise = null;
}

// ---------- 窗口 ----------
const TITLEBAR_H = 48;

function chromePalette() {
  if (nativeTheme.shouldUseDarkColors) {
    return { title: '#111111', symbol: '#c8c8c8', shell: '#0d1117' };
  }
  return { title: '#f3f3f3', symbol: '#3d3d3d', shell: '#f6f7f8' };
}
function applyNativeChrome(win, kind) {
  if (!win || win.isDestroyed()) return;
  const p = chromePalette();
  win.setBackgroundColor(kind === 'title' ? p.title : p.shell);
}
nativeTheme.on('updated', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    applyNativeChrome(win, win === mainWindow ? 'title' : 'shell');
  }
});

function viewWebContents(view) {
  return view && view.webContents;
}
function addWindowView(win, view) {
  if (typeof win.addBrowserView === 'function') {
    win.addBrowserView(view);
    if (typeof win.setTopBrowserView === 'function') win.setTopBrowserView(view);
  } else if (win.contentView && typeof win.contentView.addChildView === 'function') {
    win.contentView.addChildView(view);
  }
}
function setViewBounds(view, bounds) {
  if (view && typeof view.setBounds === 'function') view.setBounds(bounds);
}
function makeChromeView(opts) {
  return new BrowserView(opts);
}

function attachDshView(win, port) {
  const dshView = makeChromeView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  addWindowView(win, dshView);
  const dshWc = viewWebContents(dshView);
  if (dshWc) {
    dshWc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
        return { action: 'allow' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });
    dshWc.on('will-navigate', (e, url) => {
      if (!(url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'))) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
    dshWc.on('page-title-updated', (e) => {
      e.preventDefault();
      if (!win.isDestroyed()) win.setTitle(PRODUCT_NAME);
    });
    dshWc.once('did-finish-load', () => {
      layout();
      setBootProgress(100, '就绪');
      if (!win.isDestroyed()) win.show();
      closeSplash();
    });
    dshWc.once('did-fail-load', (_e, code, desc) => {
      log('dsh view failed', code, desc);
      if (!win.isDestroyed()) win.show();
      closeSplash();
    });
    dshWc.loadURL(`http://127.0.0.1:${port}/`);
  }
  const layout = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    setViewBounds(dshView, { x: 0, y: TITLEBAR_H, width: w, height: Math.max(0, h - TITLEBAR_H) });
  };
  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  layout();
  return dshWc;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: PRODUCT_NAME,
    icon: windowIcon(),
    backgroundColor: chromePalette().title,
    show: false,
    frame: false,
    thickFrame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-titlebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setTitle(PRODUCT_NAME);
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle(PRODUCT_NAME);
  });
  mainWindow.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'titlebar.html'));
  try {
    attachDshView(mainWindow, resolvedPort);
  } catch (err) {
    log('dsh view attach failed, fallback', (err && err.message) || err);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!(url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'))) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
    mainWindow.once('ready-to-show', () => {
      setBootProgress(100, '就绪');
      mainWindow.show();
      closeSplash();
    });
    mainWindow.loadURL(`http://127.0.0.1:${resolvedPort}/`);
  }
}

function attachRendererDiagnostics(win, label) {
  win.webContents.on('console-message', (_e, level, message) => {
    log(`[${label}:console]`, message);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      const probe = await win.webContents.executeJavaScript(
        `({ desktop: typeof window.desktop, saveKey: !!(window.desktop && window.desktop.saveKey) })`
      );
      log(`[${label}:probe]`, JSON.stringify(probe));
    } catch (err) {
      log(`[${label}:probe] failed:`, (err && err.message) || err);
    }
  });
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  const preloadPath = path.join(__dirname, 'preload.js');
  log('createOnboardingWindow: __dirname =', __dirname);
  log('createOnboardingWindow: preload path =', preloadPath);
  log('createOnboardingWindow: preload exists =', fs.existsSync(preloadPath));
  
  onboardingWindow = new BrowserWindow({
    width: 680,
    height: 880,
    resizable: false,
    title: `${PRODUCT_NAME} 首次设置`,
    icon: windowIcon(),
    backgroundColor: chromePalette().shell,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });
  attachRendererDiagnostics(onboardingWindow, 'onboarding');
  if (process.env.DSH_DESKTOP_SMOKE_SYNC) {
    onboardingWindow.webContents.once('did-finish-load', async () => {
      try {
        const r = await onboardingWindow.webContents.executeJavaScript(`
          (async () => {
            const sessions = await window.desktop.syncSessions();
            let update = null;
            try { update = await window.desktop.checkUpdate(); }
            catch (e) { update = { error: String(e && e.message ? e.message : e) }; }
            return { sessions, update };
          })()
        `);
        log('SMOKE_SYNC', JSON.stringify(r));
        process.stdout.write('SMOKE_SYNC ' + JSON.stringify(r) + '\n');
      } catch (err) {
        log('SMOKE_SYNC failed:', (err && err.message) || err);
        process.stdout.write('SMOKE_SYNC_FAIL ' + String(err && err.message || err) + '\n');
      } finally {
        setTimeout(() => app.quit(), 200);
      }
    });
  }
  if (process.env.DSH_DESKTOP_SMOKE_KEY) {
    onboardingWindow.webContents.once('did-finish-load', async () => {
      try {
        const key = process.env.DSH_DESKTOP_SMOKE_KEY;
        log('SMOKE: filling key and clicking save, key length:', String(key).length);
        await onboardingWindow.webContents.executeJavaScript(
          `(() => { document.getElementById('key').value = ${JSON.stringify(key)}; document.getElementById('btn-save').click(); })()`
        );
      } catch (err) {
        log('SMOKE click failed:', (err && err.message) || err);
      }
    });
  }
  onboardingWindow.setMenuBarVisibility(false);
  onboardingWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  onboardingWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== onboardingWindow.webContents.getURL()) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  onboardingWindow.loadFile(path.join(__dirname, 'onboarding.html'));
  if (process.env.DSH_DESKTOP_DEBUG) onboardingWindow.webContents.openDevTools();
  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
    if (!mainWindow && !quitting) app.quit();
  });
}

let aboutWindow = null;
function createAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 680,
    height: 800,
    resizable: true,
    title: `关于 ${PRODUCT_NAME}`,
    icon: windowIcon(),
    backgroundColor: chromePalette().shell,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.loadFile(path.join(__dirname, 'about.html'));
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  aboutWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== aboutWindow.webContents.getURL()) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

function createSettingsWindow(pane) {
  const preloadPath = path.join(__dirname, 'preload.js');
  const win = new BrowserWindow({
    width: 800,
    height: 620,
    resizable: true,
    title: `${PRODUCT_NAME} 设置`,
    icon: windowIcon(),
    backgroundColor: chromePalette().shell,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });
  attachRendererDiagnostics(win, 'settings');
  win.loadFile(path.join(__dirname, 'settings.html'));
  if (pane) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(
        `window.__showPane && window.__showPane(${JSON.stringify(String(pane))})`
      ).catch(() => {});
    });
  }
  win.setMenuBarVisibility(false);
  // 外链一律交给系统浏览器，设置窗内不跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

// ---------- 托盘 + 诊断（P4） ----------
function iconFile() {
  const tray32 = path.join(__dirname, 'build', 'icon-32.png');
  if (fs.existsSync(tray32)) return tray32;
  return path.join(__dirname, 'build', 'icon.png');
}
function windowIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  return img.isEmpty() ? undefined : img;
}
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (resolvedPort) createMainWindow();
    else boot();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function createTray() {
  if (tray) return;
  try {
    let icon = nativeImage.createFromPath(iconFile());
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip(PRODUCT_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '设置', click: () => createSettingsWindow() },
      { label: '关于', click: () => createAboutWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showMainWindow());
  } catch (e) {
    log('tray 创建失败:', (e && e.message) || e);
    tray = null;
  }
}
async function exportDiagnostic() {
  const info = kernelInfo();
  const cfg = readConfig();
  const safeCfg = { ...cfg };
  delete safeCfg.keyEnc;
  delete safeCfg.keyPlain;
  const head = [
    '=== DSH Desktop 诊断报告 ===',
    '生成时间: ' + new Date().toISOString(),
    '应用版本: ' + app.getVersion(),
    'Electron: ' + process.versions.electron,
    'Electron-Node: ' + process.versions.node,
    '自带 Node: ' + resolveNodeExe(),
    '内核版本: ' + info.version + '（已测 ' + info.testedVersion + '）',
    '内核来源: ' + info.source + '（兼容: ' + (info.compatible ? '是' : '否') + '）',
    'DSH_HOME: ' + dshHome() + (prefs().shareWebHome ? '（共用网页端）' : '（隔离）'),
    '隔离目录: ' + isolatedDshHome(),
    '网页端目录: ' + defaultSourceHome(),
    '系统: ' + os.platform() + ' ' + os.release() + ' ' + os.arch(),
    '总内存: ' + Math.round(os.totalmem() / 1048576) + ' MB',
    '',
    '=== 配置（已脱敏，不含密钥） ===',
    JSON.stringify(safeCfg, null, 2),
    '',
    '=== 日志 dsh-desktop.log ===',
  ].join('\n');
  let logText = '';
  try { logText = fs.readFileSync(logPath(), 'utf8'); } catch {}
  const defaultPath = path.join(app.getPath('desktop'), 'dsh-desktop-diagnostic-' + Date.now() + '.txt');
  const r = await dialog.showSaveDialog({ title: '保存诊断报告', defaultPath, filters: [{ name: '文本文件', extensions: ['txt'] }] });
  if (r.canceled || !r.filePath) return { saved: false };
  fs.writeFileSync(r.filePath, head + '\n' + logText, 'utf8');
  log('export-diagnostic:', r.filePath);
  return { saved: true, path: r.filePath };
}

function prefs() {
  const cfg = readConfig();
  return {
    autoSyncSessions: cfg.autoSyncSessions !== false,
    autoUpdateKernel: cfg.autoUpdateKernel === true,
    shareWebHome: cfg.shareWebHome === true,
  };
}
async function setPrefs(next) {
  const cfg = readConfig();
  if (typeof next.autoSyncSessions === 'boolean') cfg.autoSyncSessions = next.autoSyncSessions;
  if (typeof next.autoUpdateKernel === 'boolean') cfg.autoUpdateKernel = next.autoUpdateKernel;
  let homeChanged = false;
  if (typeof next.shareWebHome === 'boolean' && next.shareWebHome !== (cfg.shareWebHome === true)) {
    if (next.shareWebHome && !next.confirmed) {
      const win = BrowserWindow.getFocusedWindow() || mainWindow || onboardingWindow || undefined;
      const box = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning',
        title: PRODUCT_NAME,
        message: '和网页端共用 ~/.dsh？',
        detail: '两边会读写同一份数据。先关掉本机 dsh web。桌面端现有会话不会搬过去，改完要重启。',
        buttons: ['取消', '共用'],
        defaultId: 0,
        cancelId: 0,
      });
      if (box.response !== 1) return { ...prefs(), cancelled: true, homeChanged: false };
    }
    cfg.shareWebHome = next.shareWebHome;
    homeChanged = true;
  }
  writeConfig(cfg);
  return { ...prefs(), cancelled: false, homeChanged };
}
function maybeAutoSyncSessions() {
  if (prefs().shareWebHome || sameHome(defaultSourceHome(), dshHome())) {
    log('auto-sync sessions: skipped same-home');
    return { skipped: true, reason: 'same-home' };
  }
  if (!prefs().autoSyncSessions) {
    log('auto-sync sessions: disabled');
    return { skipped: true, reason: 'disabled' };
  }
  const src = detectSource();
  if (!src.exists || !src.count) {
    log('auto-sync sessions: no local web sessions');
    return { skipped: true, reason: 'no-source' };
  }
  try {
    return syncSessions(src.home);
  } catch (err) {
    log('auto-sync sessions failed:', (err && err.message) || err);
    return { skipped: true, reason: String((err && err.message) || err) };
  }
}
async function maybeAutoUpdateKernel() {
  if (justAppliedUpdate) return;
  if (!prefs().autoUpdateKernel) {
    log('auto-update kernel: disabled');
    return;
  }
  const cfg0 = readConfig();
  if (cfg0.lastUpdateOk === false && cfg0.lastUpdateAttempt) {
    const t = Date.parse(cfg0.lastUpdateAttempt);
    if (Number.isFinite(t) && Date.now() - t < 6 * 3600 * 1000) {
      log('auto-update kernel: skipped, last failure', cfg0.lastUpdateAttempt);
      return;
    }
  }
  try {
    const r = await checkUpdate();
    if (!r.hasUpdate) {
      log('auto-update kernel: already latest', r.current);
      return;
    }
    const compat = checkCompatibility(r.latest);
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!compat.ok && compat.level === 'major') {
      const box = await dialog.showMessageBox(win || undefined, {
        type: 'warning',
        title: PRODUCT_NAME,
        message: `内核 ${r.latest} 主版本变了`,
        detail: `${compat.reason}\n当前 ${r.current}。`,
        buttons: ['先不更', '更新'],
        defaultId: 0,
        cancelId: 0,
      });
      if (box.response !== 1) return;
    }
    log('auto-update kernel: applying', r.latest, 'from', r.current);
    showUpdateProgressWindow();
    const applied = await applyUpdate();
    justAppliedUpdate = true;
    await dialog.showMessageBox(win || updateWindow || undefined, {
      type: 'info',
      title: PRODUCT_NAME,
      message: `内核已更新到 ${applied.version}`,
      detail: '确定后重启。会话和配置还在。',
    });
    quitting = true;
    app.relaunch();
    app.quit();
  } catch (err) {
    log('auto-update kernel failed:', (err && err.message) || err);
    showUpdateProgressWindow();
    emitUpdateProgress({
      phase: 'error',
      text: '自动更新失败',
      error: String((err && err.message) || err),
    });
  }
}

// ---------- 启动 ----------
async function boot() {
  if (resolvedPort !== null && dshChild) return;
  try {
    await showSplash();
    const cold = isColdKernelBoot();
    const coldHint = '第一次打开这个内核会比较慢（新装或刚更新都一样）。读文件时安全软件也可能在扫。等一两分钟都正常，先别关。';
    setBootProgress(10, '正在准备运行环境…', cold ? coldHint : '');
    resolvedPort = await getFreePort(PREFERRED_PORT);
    log('use port', resolvedPort, cold ? 'cold-kernel' : 'warm-kernel');
    setBootProgress(28, cold ? '正在启动内核，第一次会慢一些…' : '正在启动内核…', cold ? coldHint : '');
    startDsh(resolvedPort);
    await waitForReady(
      resolvedPort,
      cold ? COLD_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
      (frac, elapsed) => {
        const pct = 28 + Math.round(frac * 62);
        let text;
        if (elapsed < 10000) text = cold ? '正在加载内核（首次会慢）…' : '正在加载内核…';
        else if (elapsed < 30000) text = '还在加载，已等 ' + formatElapsed(elapsed) + (cold ? '。别急，第一次总是慢一些' : '');
        else text = '仍在等内核就绪，已 ' + formatElapsed(elapsed) + '。新内核第一次打开经常要一两分钟';
        setBootProgress(pct, text, cold ? coldHint : '');
      },
      cold ? 80000 : 20000
    );
    markKernelWarm();
    log('ready on', resolvedPort);
    setBootProgress(94, '正在打开主界面…', '');
    createMainWindow();
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    maybeAutoUpdateKernel();
  } catch (err) {
    log('boot failed:', err && (err.stack || err.message) || err);
    closeSplash();
    dialog.showErrorBox(
      `${PRODUCT_NAME} 启动失败`,
      String((err && err.message) || err)
    );
    app.quit();
  }
}

// ---------- IPC ----------
ipcMain.handle('desktop:get-state', () => {
  const cfg = readConfig();
  return {
    hasKey: getApiKey().length > 0,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    sessions: detectSource(),
    lastSessionSync: cfg.lastSessionSync || null,
    kernel: kernelInfo(),
    prefs: prefs(),
    dshHome: dshHome(),
    isolatedHome: isolatedDshHome(),
    webHome: defaultSourceHome(),
    sharingWebHome: prefs().shareWebHome,
    lastUpdateOk: cfg.lastUpdateOk,
    lastUpdateAttempt: cfg.lastUpdateAttempt,
    lastUpdateError: cfg.lastUpdateError,
  };
});
ipcMain.handle('desktop:get-prefs', () => prefs());
ipcMain.handle('desktop:set-prefs', (_e, next) => setPrefs(next || {}));
ipcMain.handle('desktop:relaunch', () => {
  log('IPC desktop:relaunch');
  quitting = true;
  app.relaunch();
  app.quit();
  return true;
});
function applyOnboardingExtra(extra) {
  if (!extra || typeof extra !== 'object') return Promise.resolve();
  const next = { confirmed: true };
  if (typeof extra.shareWebHome === 'boolean') next.shareWebHome = extra.shareWebHome;
  if (typeof extra.autoSyncSessions === 'boolean') next.autoSyncSessions = extra.autoSyncSessions;
  if (typeof extra.autoUpdateKernel === 'boolean') next.autoUpdateKernel = extra.autoUpdateKernel;
  return setPrefs(next);
}
ipcMain.handle('desktop:save-key', async (_e, key, extra) => {
  log('IPC desktop:save-key received, key length:', String(key || '').length);
  await applyOnboardingExtra(extra);
  setApiKey(key);
  boot();
  return true;
});
ipcMain.handle('desktop:skip', async (_e, extra) => {
  log('IPC desktop:skip received');
  await applyOnboardingExtra(extra);
  boot();
  return true;
});
ipcMain.handle('desktop:kernel-info', () => kernelInfo());
ipcMain.handle('desktop:check-update', () => checkUpdate());
ipcMain.handle('desktop:apply-update', () => applyUpdate());
ipcMain.handle('desktop:sync-official-update', () => syncOfficialUpdate());
ipcMain.handle('desktop:rollback', () => rollback());
ipcMain.handle('desktop:detect-source', (_e, home) => detectSource(home));
ipcMain.handle('desktop:import-sessions', (_e, sourceHome) => {
  const src = sourceHome && String(sourceHome).trim() ? String(sourceHome).trim() : defaultSourceHome();
  return syncSessions(src);
});
ipcMain.handle('desktop:sync-sessions', (_e, sourceHome) => {
  const src = sourceHome && String(sourceHome).trim() ? String(sourceHome).trim() : defaultSourceHome();
  return syncSessions(src);
});
ipcMain.handle('desktop:get-dynamics', () => getDynamics());
ipcMain.handle('desktop:export-diagnostic', () => exportDiagnostic());
ipcMain.handle('desktop:open-about', () => {
  createAboutWindow();
  return true;
});
ipcMain.handle('desktop:open-settings', (_e, pane) => {
  createSettingsWindow(pane);
  return true;
});
ipcMain.handle('desktop:update-progress-now', () => lastUpdateProgress);
ipcMain.handle('desktop:win-toggle', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return true;
});
ipcMain.handle('desktop:win-min', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.minimize();
  return true;
});
ipcMain.handle('desktop:win-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.close();
  return true;
});

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log('==== DSH Desktop start ====');
    log('electron', process.versions.electron, 'node-runner', resolveNodeExe());
    const kinfo = kernelInfo();
    log('kernel', kinfo.version, 'source=', kinfo.source, 'compatible=', kinfo.compatible);
    log('DSH_HOME mode=', prefs().shareWebHome ? 'share-web' : 'isolated', dshHome());
    if (!kinfo.compatible) {
      log('WARN kernel compatibility:', kinfo.compatLevel, kinfo.compatReason);
    }
    const existingKeyEarly = getApiKey();
    if (existingKeyEarly.length > 0) {
      await showSplash();
      if (prefs().autoSyncSessions && !prefs().shareWebHome) {
        setBootProgress(6, '正在同步网页端会话与外接模型…');
      } else {
        setBootProgress(6, '正在启动…');
      }
    }
    const syncResult = maybeAutoSyncSessions();
    if (existingKeyEarly.length > 0) {
      if (syncResult && syncResult.skipped !== true) {
        setBootProgress(20, '同步完成，正在启动…');
      } else {
        setBootProgress(20, '正在启动…');
      }
    }

    const menu = Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [{ label: '设置', click: () => createSettingsWindow() }, { type: 'separator' }, { label: '退出', role: 'quit' }],
      },
      {
        label: '帮助',
        submenu: [
          { label: '关于', click: () => createAboutWindow() },
          { label: '官方仓库', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
          { label: '官方 Discussions', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness/discussions') },
          { type: 'separator' },
          { label: '打开日志', click: () => shell.openPath(logPath()) },
          { label: '版本', click: () => dialog.showMessageBox({ type: 'info', title: PRODUCT_NAME, message: PRODUCT_NAME, detail: `Zer0 · 非官方\nDSH ${kinfo.version}（已测 ${TESTED_DSH_VERSION}）\nElectron ${process.versions.electron}\ngl20070126@gmail.com` }) },
        ],
      },
    ]);
    Menu.setApplicationMenu(menu);
    createTray();

    const existingKey = getApiKey();
    log('startup hasKey=', existingKey.length > 0, 'encAvail=', safeStorage.isEncryptionAvailable());
    if (existingKey.length > 0) {
      boot();
    } else {
      createOnboardingWindow();
    }
  }).catch((err) => {
    log('whenReady failed:', err && (err.stack || err.message) || err);
    closeSplash();
    dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, String((err && err.message) || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    log('window-all-closed');
    app.quit();
  });
  app.on('before-quit', () => {
    log('before-quit');
    quitting = true;
    closeSplash();
    stopDsh();
  });
  app.on('will-quit', () => {
    log('will-quit');
    stopDsh();
  });
}
