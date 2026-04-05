const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const {
  handleFetchRepos, handleAnalyzeWithAI, handleTestConnection,
  handleStartGitHubLogin, handlePollGitHubToken, handleLoginWithPat,
  handleGetAuthStatus, handleLogout, handleSaveAiConfig, handleLoadAiConfig,
  logEmitter,
} = require('./ipc');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5290');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  // Auth
  ipcMain.handle('get-auth-status', () => handleGetAuthStatus());
  ipcMain.handle('start-github-login', async () => handleStartGitHubLogin());
  ipcMain.handle('poll-github-token', async (_, data) => handlePollGitHubToken(data.deviceCode, data.interval));
  ipcMain.handle('login-with-github-pat', async (_, token) => handleLoginWithPat(token));
  ipcMain.handle('logout', () => handleLogout());
  ipcMain.handle('open-url', (_, url) => shell.openExternal(url));
  ipcMain.handle('save-ai-config', (_, config) => handleSaveAiConfig(config));
  ipcMain.handle('load-ai-config', () => handleLoadAiConfig());

  // Window controls
  ipcMain.handle('minimize', () => mainWindow.minimize());
  ipcMain.handle('maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('close', () => mainWindow.close());

  // Core
  ipcMain.handle('fetch-repos', async (_, config) => handleFetchRepos(config, mainWindow));
  ipcMain.handle('analyze-repos', async (_, data) => handleAnalyzeWithAI(data.aiConfig, data.repos, mainWindow));
  ipcMain.handle('test-connection', async (_, aiConfig) => handleTestConnection(aiConfig));

  // Log streaming
  logEmitter.on('log', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-entry', entry);
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
