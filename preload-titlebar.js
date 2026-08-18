const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopChrome', {
  settings: () => ipcRenderer.invoke('desktop:open-settings'),
  about: () => ipcRenderer.invoke('desktop:open-about'),
  min: () => ipcRenderer.invoke('desktop:win-min'),
  toggleMax: () => ipcRenderer.invoke('desktop:win-toggle'),
  close: () => ipcRenderer.invoke('desktop:win-close'),
});
