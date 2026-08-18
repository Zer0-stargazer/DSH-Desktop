// 用真实 ~/.dsh 做源、临时目录做目标，验证会话索引/模型/凭据合并。不打印密钥值。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mergeWorkspaceIndex,
  mergeSessionProjcache,
  mergeSettingsModels,
  mergeCredentials,
  sameHome,
  resolveDshHome,
} = require('./sync-from-web');

const srcHome = path.join(os.homedir(), '.dsh');
const liveDest = path.join(process.env.APPDATA || '', 'DSH Desktop', 'dsh-home');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-test-'));

function fail(msg) {
  console.error('FAIL', msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log('OK', msg);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function yamlLoad(file) {
  return require('js-yaml').load(fs.readFileSync(file, 'utf8'));
}

try {
  if (!fs.existsSync(path.join(srcHome, 'settings.yaml'))) {
    throw new Error('missing source settings: ' + srcHome);
  }

  // 模拟当前桌面端：只有主题、几乎空的 projcache
  copyFile(path.join(liveDest, 'settings.yaml'), path.join(tmp, 'settings.yaml'));
  copyFile(path.join(liveDest, 'storages', 'workspace.json'), path.join(tmp, 'storages', 'workspace.json'));
  copyFile(path.join(liveDest, 'storages', 'session_projcache.json'), path.join(tmp, 'storages', 'session_projcache.json'));

  const ws = mergeWorkspaceIndex(srcHome, tmp);
  const cache = mergeSessionProjcache(srcHome, tmp);
  const models = mergeSettingsModels(srcHome, tmp);
  const creds = mergeCredentials(srcHome, tmp);

  const destSettings = yamlLoad(path.join(tmp, 'settings.yaml'));
  const destWs = JSON.parse(fs.readFileSync(path.join(tmp, 'storages', 'workspace.json'), 'utf8'));
  const destCache = JSON.parse(fs.readFileSync(path.join(tmp, 'storages', 'session_projcache.json'), 'utf8'));
  const destCreds = yamlLoad(path.join(tmp, '.credentials.yaml'));

  const providers = Object.keys((((destSettings['llm-pi-ai'] || {}).providers) || {}));
  const titles = Object.entries((destCache.tables && destCache.tables.sessions) || {})
    .map(([id, e]) => [id, e && e.rows && e.rows.title && e.rows.title.val])
    .filter(([, t]) => t);

  const destSessionIds = new Set();
  for (const wsItem of Object.values((destWs.tables && destWs.tables.workspaces) || {})) {
    for (const id of (wsItem && wsItem.sessionIds) || []) destSessionIds.add(id);
  }

  console.log(JSON.stringify({
    tmp,
    workspace: ws,
    projcache: cache,
    models: {
      merged: models.merged,
      providersAdded: models.providersAdded,
      defaultModelSynced: models.defaultModelSynced,
      providerCount: models.providerCount,
    },
    credentials: { merged: creds.merged, keysAdded: creds.keysAdded, keyCount: creds.keyCount },
    destTheme: destSettings['ui-theme'],
    destProviders: providers,
    destDefaultModel: destSettings['agent-default-model'] || null,
    destTitles: titles.map(([, t]) => t),
    destHasDesktopOnly: destSessionIds.has('session-8c1903c2-4f54-43e2-b731-ee2a323340c2'),
    destHasWebSession: destSessionIds.has('session-8fd412ca-678f-49b0-ac0d-38341be693dc'),
    credKeyNames: Object.keys(destCreds || {}),
  }, null, 2));

  if (!providers.includes('geimini') || !providers.includes('claude') || !providers.includes('otherdeepseek')) {
    fail('missing expected providers: ' + providers.join(','));
  } else ok('providers synced');

  if (!destSettings['agent-default-model']) fail('default model not synced');
  else ok('default model synced');

  if (!destSettings['ui-theme'] || destSettings['ui-theme'].preference !== 'light') {
    fail('desktop theme was overwritten');
  } else ok('desktop theme kept');

  if (!titles.some(([, t]) => t === '封装端口为桌面版') || !titles.some(([, t]) => t === 'Gemini与DeepSeek能力对比')) {
    fail('session titles missing: ' + titles.map(([, t]) => t).join(' | '));
  } else ok('session titles synced');

  if (!destSessionIds.has('session-8c1903c2-4f54-43e2-b731-ee2a323340c2')) {
    fail('desktop-only session was dropped');
  } else ok('desktop-only session kept');

  const expectedKeys = ['DEEPSEEK_API_KEY', 'GEIMINI_API_KEY', 'CLAUDE_API_KEY', 'OTHERDEEPSEEK_API_KEY'];
  const missing = expectedKeys.filter((k) => !destCreds || !destCreds[k]);
  if (missing.length) fail('credential keys missing: ' + missing.join(','));
  else ok('credential key names synced');

  const dumped = JSON.stringify(destCreds);
  if (Object.values(destCreds).some((v) => typeof v === 'string' && v.length > 8 && process.stdout && dumped.includes('sk-'))) {
    // 只确认测试输出对象里没有把值打到前面的 JSON（我们只打了 key names）
  }

  const cli = path.join(os.homedir(), '.dsh');
  const isolated = path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'dsh-home');
  if (!sameHome(cli, path.join(os.homedir(), '.dsh'))) fail('sameHome failed on identical cli path');
  else ok('sameHome identical');
  if (!sameHome(cli, cli.replace(/\\/g, '/'))) fail('sameHome failed on slash normalize');
  else ok('sameHome slash normalize');
  if (sameHome(cli, isolated)) fail('sameHome should differ isolated vs cli');
  else ok('sameHome isolated != cli');
  if (resolveDshHome(isolated, cli, false) !== isolated) fail('resolve isolated');
  else ok('resolve isolated');
  if (resolveDshHome(isolated, cli, true) !== cli) fail('resolve share');
  else ok('resolve share');

  const splash = fs.readFileSync(path.join(__dirname, 'splash.html'), 'utf8');
  if (!splash.includes('window.__setProgress')) fail('splash missing progress hook');
  else ok('splash progress hook present');

  if (!process.exitCode) console.log('ALL_PASS');
} catch (e) {
  fail((e && e.stack) || e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
