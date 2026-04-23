const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchRepos: (config) => ipcRenderer.invoke('fetch-repos', config),
  analyzeRepos: (data) => ipcRenderer.invoke('analyze-repos', data),
  fetchSelectedReadmes: (payload) => ipcRenderer.invoke('fetch-selected-readmes', payload),
  selectRepoImages: (payload) => ipcRenderer.invoke('select-repo-images', payload),
  testConnection: (config) => ipcRenderer.invoke('test-connection', config),
  loadPresentationConfig: () => ipcRenderer.invoke('load-presentation-config'),
  savePresentationConfig: (config) => ipcRenderer.invoke('save-presentation-config', config),
  testPresentationTts: (config) => ipcRenderer.invoke('test-presentation-tts', config),
  selectPresentationManifest: () => ipcRenderer.invoke('select-presentation-manifest'),
  preparePresentationSession: (payload) => ipcRenderer.invoke('prepare-presentation-session', payload),

  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  startGitHubLogin: () => ipcRenderer.invoke('start-github-login'),
  pollGitHubToken: (data) => ipcRenderer.invoke('poll-github-token', data),
  loginWithGitHubPat: (token) => ipcRenderer.invoke('login-with-github-pat', token),
  logout: () => ipcRenderer.invoke('logout'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openLocalPath: (targetPath) => ipcRenderer.invoke('open-local-path', targetPath),
  openReadmeRecorder: (payload) => ipcRenderer.invoke('open-readme-recorder', payload),
  saveAiConfig: (config) => ipcRenderer.invoke('save-ai-config', config),
  loadAiConfig: () => ipcRenderer.invoke('load-ai-config'),

  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (_, entry) => callback(entry));
  },
  onPresentationProgress: (callback) => {
    const handler = (_, progress) => callback(progress);
    ipcRenderer.on('presentation-progress', handler);
    return () => ipcRenderer.removeListener('presentation-progress', handler);
  },

  // Window controls
  minimize: () => ipcRenderer.invoke('minimize'),
  maximize: () => ipcRenderer.invoke('maximize'),
  close: () => ipcRenderer.invoke('close'),
});
