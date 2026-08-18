// 把本机网页端 ~/.dsh 的会话索引、外接模型和凭据合并进桌面端 DSH_HOME。
// 只做增量合并：不删桌面端已有会话，不覆盖桌面端已有密钥/主题。
// 凭据值不得写入日志。

const fs = require('fs');
const path = require('path');

function tryYaml() {
  try {
    return require('js-yaml');
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function sameHome(a, b) {
  if (!a || !b) return false;
  try {
    return normPath(path.resolve(String(a))) === normPath(path.resolve(String(b)));
  } catch {
    return normPath(a) === normPath(b);
  }
}

function resolveDshHome(isolatedHome, cliHome, shareWebHome) {
  return shareWebHome ? cliHome : isolatedHome;
}

function maxRowSeq(entry) {
  let max = 0;
  const rows = entry && entry.rows && typeof entry.rows === 'object' ? entry.rows : {};
  for (const row of Object.values(rows)) {
    const seq = row && typeof row.seq === 'number' ? row.seq : 0;
    if (seq > max) max = seq;
  }
  return max;
}

function mergeWorkspaceIndex(srcHome, destHome) {
  const srcPath = path.join(srcHome, 'storages', 'workspace.json');
  const destPath = path.join(destHome, 'storages', 'workspace.json');
  if (!fs.existsSync(srcPath)) return { merged: false, reason: 'no-source' };
  const src = readJson(srcPath, null);
  if (!src) return { merged: false, reason: 'bad-source' };
  if (!fs.existsSync(destPath)) {
    writeJson(destPath, src);
    const tables = (src.tables && src.tables.workspaces) || {};
    return {
      merged: true,
      copied: true,
      addedWorkspaces: Object.keys(tables).length,
      addedSessions: Object.values(tables).reduce((n, ws) => n + ((ws && ws.sessionIds) || []).length, 0),
      titlesUpdated: 0,
    };
  }
  const dest = readJson(destPath, null);
  if (!dest) return { merged: false, reason: 'bad-dest' };
  dest.tables = dest.tables || {};
  dest.tables.workspaces = dest.tables.workspaces || {};
  dest.global = dest.global || {};
  dest.global.initialized = true;
  dest.global.workspaceIds = Array.isArray(dest.global.workspaceIds) ? dest.global.workspaceIds.slice() : [];
  dest.global.archivedSessionIds = Array.isArray(dest.global.archivedSessionIds) ? dest.global.archivedSessionIds.slice() : [];

  const destByPath = Object.create(null);
  for (const [id, ws] of Object.entries(dest.tables.workspaces)) {
    if (ws && ws.path) destByPath[normPath(ws.path)] = { id, ws };
  }

  let addedWorkspaces = 0;
  let addedSessions = 0;
  let titlesUpdated = 0;
  const srcWorkspaces = (src.tables && src.tables.workspaces) || {};
  for (const [srcId, srcWs] of Object.entries(srcWorkspaces)) {
    if (!srcWs || !srcWs.path) continue;
    const key = normPath(srcWs.path);
    const hit = destByPath[key];
    if (hit) {
      const destWs = hit.ws;
      const set = new Set(Array.isArray(destWs.sessionIds) ? destWs.sessionIds : []);
      for (const sid of srcWs.sessionIds || []) {
        if (!set.has(sid)) {
          set.add(sid);
          addedSessions += 1;
        }
      }
      destWs.sessionIds = Array.from(set);
      const folderName = path.basename(srcWs.path);
      if (srcWs.title && (!destWs.title || destWs.title === folderName) && destWs.title !== srcWs.title) {
        destWs.title = srcWs.title;
        titlesUpdated += 1;
      }
      if (srcWs.updatedAt && (!destWs.updatedAt || srcWs.updatedAt > destWs.updatedAt)) {
        destWs.updatedAt = srcWs.updatedAt;
      }
    } else {
      dest.tables.workspaces[srcId] = srcWs;
      if (!dest.global.workspaceIds.includes(srcId)) dest.global.workspaceIds.push(srcId);
      destByPath[key] = { id: srcId, ws: dest.tables.workspaces[srcId] };
      addedWorkspaces += 1;
      addedSessions += (srcWs.sessionIds || []).length;
    }
  }

  const srcArchived = (src.global && src.global.archivedSessionIds) || [];
  const archived = new Set(dest.global.archivedSessionIds);
  for (const id of srcArchived) archived.add(id);
  dest.global.archivedSessionIds = Array.from(archived);

  writeJson(destPath, dest);
  return { merged: true, copied: false, addedWorkspaces, addedSessions, titlesUpdated };
}

function mergeSessionProjcache(srcHome, destHome) {
  const srcPath = path.join(srcHome, 'storages', 'session_projcache.json');
  const destPath = path.join(destHome, 'storages', 'session_projcache.json');
  if (!fs.existsSync(srcPath)) return { merged: false, reason: 'no-source' };
  const src = readJson(srcPath, null);
  if (!src) return { merged: false, reason: 'bad-source' };
  if (!fs.existsSync(destPath)) {
    writeJson(destPath, src);
    const n = Object.keys((src.tables && src.tables.sessions) || {}).length;
    return { merged: true, copied: true, added: n, updated: 0 };
  }
  const dest = readJson(destPath, null);
  if (!dest) return { merged: false, reason: 'bad-dest' };
  dest.tables = dest.tables || {};
  dest.tables.sessions = dest.tables.sessions || {};
  const srcSessions = (src.tables && src.tables.sessions) || {};
  let added = 0;
  let updated = 0;
  for (const [id, srcEntry] of Object.entries(srcSessions)) {
    const destEntry = dest.tables.sessions[id];
    if (!destEntry) {
      dest.tables.sessions[id] = srcEntry;
      added += 1;
      continue;
    }
    if (maxRowSeq(srcEntry) > maxRowSeq(destEntry)) {
      dest.tables.sessions[id] = srcEntry;
      updated += 1;
    }
  }
  writeJson(destPath, dest);
  return { merged: true, copied: false, added, updated };
}

function mergeSettingsModels(srcHome, destHome) {
  const yaml = tryYaml();
  const srcPath = path.join(srcHome, 'settings.yaml');
  const destPath = path.join(destHome, 'settings.yaml');
  if (!yaml) return { merged: false, reason: 'no-yaml' };
  if (!fs.existsSync(srcPath)) return { merged: false, reason: 'no-source' };
  let src;
  try {
    src = yaml.load(fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return { merged: false, reason: 'bad-source' };
  }
  if (!src || typeof src !== 'object') return { merged: false, reason: 'bad-source' };

  let dest = {};
  if (fs.existsSync(destPath)) {
    try {
      dest = yaml.load(fs.readFileSync(destPath, 'utf8').replace(/^\uFEFF/, '')) || {};
    } catch {
      return { merged: false, reason: 'bad-dest' };
    }
    if (!dest || typeof dest !== 'object') dest = {};
  }

  const srcProviders = (((src['llm-pi-ai'] || {}).providers) || {});
  dest['llm-pi-ai'] = dest['llm-pi-ai'] && typeof dest['llm-pi-ai'] === 'object' ? dest['llm-pi-ai'] : {};
  dest['llm-pi-ai'].providers = dest['llm-pi-ai'].providers && typeof dest['llm-pi-ai'].providers === 'object'
    ? dest['llm-pi-ai'].providers
    : {};

  const providersAdded = [];
  const providersUpdated = [];
  for (const [id, provider] of Object.entries(srcProviders)) {
    if (!provider || typeof provider !== 'object') continue;
    if (!dest['llm-pi-ai'].providers[id]) {
      dest['llm-pi-ai'].providers[id] = provider;
      providersAdded.push(id);
    } else {
      // 网页端模型列表更新时，补桌面端没有的模型，不删桌面端已加的
      const destProv = dest['llm-pi-ai'].providers[id];
      const srcModels = Array.isArray(provider.models) ? provider.models : [];
      const destModels = Array.isArray(destProv.models) ? destProv.models : [];
      const have = new Set(destModels.map((m) => m && m.id).filter(Boolean));
      let changed = false;
      for (const m of srcModels) {
        if (m && m.id && !have.has(m.id)) {
          destModels.push(m);
          have.add(m.id);
          changed = true;
        }
      }
      destProv.models = destModels;
      if (!destProv.displayName && provider.displayName) destProv.displayName = provider.displayName;
      if (!destProv.apiKeyEnv && provider.apiKeyEnv) destProv.apiKeyEnv = provider.apiKeyEnv;
      if (!destProv.api && provider.api) destProv.api = provider.api;
      if (!destProv.baseURL && provider.baseURL) destProv.baseURL = provider.baseURL;
      if (changed) providersUpdated.push(id);
    }
  }

  let defaultModelSynced = false;
  if (src['agent-default-model'] && !dest['agent-default-model']) {
    dest['agent-default-model'] = src['agent-default-model'];
    defaultModelSynced = true;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, yaml.dump(dest, { lineWidth: 120, noRefs: true }));
  return {
    merged: true,
    providersAdded,
    providersUpdated,
    defaultModelSynced,
    providerCount: Object.keys(dest['llm-pi-ai'].providers).length,
  };
}

function mergeCredentials(srcHome, destHome) {
  const yaml = tryYaml();
  const srcPath = path.join(srcHome, '.credentials.yaml');
  const destPath = path.join(destHome, '.credentials.yaml');
  if (!yaml) return { merged: false, reason: 'no-yaml', keysAdded: [] };
  if (!fs.existsSync(srcPath)) return { merged: false, reason: 'no-source', keysAdded: [] };
  let src;
  try {
    src = yaml.load(fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return { merged: false, reason: 'bad-source', keysAdded: [] };
  }
  if (!src || typeof src !== 'object') return { merged: false, reason: 'bad-source', keysAdded: [] };

  let dest = {};
  if (fs.existsSync(destPath)) {
    try {
      dest = yaml.load(fs.readFileSync(destPath, 'utf8').replace(/^\uFEFF/, '')) || {};
    } catch {
      return { merged: false, reason: 'bad-dest', keysAdded: [] };
    }
    if (!dest || typeof dest !== 'object') dest = {};
  }

  const keysAdded = [];
  for (const [key, value] of Object.entries(src)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    const cur = dest[key];
    if (typeof cur !== 'string' || !cur.trim()) {
      dest[key] = value.trim();
      keysAdded.push(key);
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, yaml.dump(dest, { lineWidth: 120, noRefs: true }));
  return { merged: true, keysAdded, keyCount: Object.keys(dest).length };
}

function applyCredentialEnv(env, home) {
  const yaml = tryYaml();
  const credPath = path.join(home, '.credentials.yaml');
  const injected = [];
  if (!yaml || !fs.existsSync(credPath)) return injected;
  let obj;
  try {
    obj = yaml.load(fs.readFileSync(credPath, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return injected;
  }
  if (!obj || typeof obj !== 'object') return injected;
  for (const [key, value] of Object.entries(obj)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!env[key]) {
      env[key] = value.trim();
      injected.push(key);
    }
  }
  return injected;
}

module.exports = {
  mergeWorkspaceIndex,
  mergeSessionProjcache,
  mergeSettingsModels,
  mergeCredentials,
  applyCredentialEnv,
  sameHome,
  resolveDshHome,
  normPath,
};
