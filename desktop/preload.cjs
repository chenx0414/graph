/** Minimal, message-based bridge for the desktop shell. No Node access is
 * exposed to the page: directory picking and keychain writes stay in main. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('graph', {
  isDesktop: true,
  pickDirectory: () => ipcRenderer.invoke('graph:pick-directory'),
  openResource: kind => ipcRenderer.invoke('graph:open-resource', kind),
  saveSecret: (ref, value) => ipcRenderer.invoke('graph:save-secret', ref, value),
  secretStatus: refs => ipcRenderer.invoke('graph:secret-status', refs),
  relaunch: () => ipcRenderer.invoke('graph:relaunch'),
});
