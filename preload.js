const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] preload.js is running');

try {
  contextBridge.exposeInMainWorld('desktop', {
    getState: () => ipcRenderer.invoke('desktop:get-state'),
    saveKey: (key, extra) => ipcRenderer.invoke('desktop:save-key', key, extra || {}),
    skip: (extra) => ipcRenderer.invoke('desktop:skip', extra || {}),
    kernelInfo: () => ipcRenderer.invoke('desktop:kernel-info'),
    checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
    applyUpdate: () => ipcRenderer.invoke('desktop:apply-update'),
    syncOfficialUpdate: () => ipcRenderer.invoke('desktop:sync-official-update'),
    rollback: () => ipcRenderer.invoke('desktop:rollback'),
    detectSource: (home) => ipcRenderer.invoke('desktop:detect-source', home),
    importSessions: (sourceHome) => ipcRenderer.invoke('desktop:import-sessions', sourceHome),
    syncSessions: (sourceHome) => ipcRenderer.invoke('desktop:sync-sessions', sourceHome),
    getDynamics: () => ipcRenderer.invoke('desktop:get-dynamics'),
    exportDiagnostic: () => ipcRenderer.invoke('desktop:export-diagnostic'),
    getPrefs: () => ipcRenderer.invoke('desktop:get-prefs'),
    setPrefs: (prefs) => ipcRenderer.invoke('desktop:set-prefs', prefs),
    relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
    openAbout: () => ipcRenderer.invoke('desktop:open-about'),
    openSettings: (pane) => ipcRenderer.invoke('desktop:open-settings', pane),
    onUpdateProgress: (cb) => {
      const fn = (_e, p) => { try { cb(p); } catch {} };
      ipcRenderer.on('desktop:update-progress', fn);
      return () => ipcRenderer.removeListener('desktop:update-progress', fn);
    },
    updateProgressNow: () => ipcRenderer.invoke('desktop:update-progress-now'),
  });
  console.log('[PRELOAD] window.desktop exposed successfully');
} catch (err) {
  console.error('[PRELOAD] Failed to expose window.desktop:', err);
}
