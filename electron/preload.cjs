const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchRepos: (config) => ipcRenderer.invoke('fetch-repos', config),
  analyzeRepos: (data) => ipcRenderer.invoke('analyze-repos', data),
  testConnection: (config) => ipcRenderer.invoke('test-connection', config),

  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  startGitHubLogin: () => ipcRenderer.invoke('start-github-login'),
  pollGitHubToken: (data) => ipcRenderer.invoke('poll-github-token', data),
  loginWithGitHubPat: (token) => ipcRenderer.invoke('login-with-github-pat', token),
  logout: () => ipcRenderer.invoke('logout'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  saveAiConfig: (config) => ipcRenderer.invoke('save-ai-config', config),
  loadAiConfig: () => ipcRenderer.invoke('load-ai-config'),

  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (_, entry) => callback(entry));
  },

  // Window controls
  minimize: () => ipcRenderer.invoke('minimize'),
  maximize: () => ipcRenderer.invoke('maximize'),
  close: () => ipcRenderer.invoke('close'),
});
