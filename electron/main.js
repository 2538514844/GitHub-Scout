const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const {
  handleFetchRepos,
  handleAnalyzeWithAI,
  handleFetchSelectedReadmes,
  handleTestConnection,
  handleStartGitHubLogin,
  handlePollGitHubToken,
  handleLoginWithPat,
  handleGetAuthStatus,
  handleLogout,
  handleSaveAiConfig,
  handleLoadAiConfig,
  logEmitter,
} = require('./ipc');
const {
  loadPresentationConfig,
  savePresentationConfig,
  preparePresentationSession,
  loadPresentationManifest,
  testPresentationTts,
} = require('./presentation');

let mainWindow;

function createWindow() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5290';

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
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('get-auth-status', () => handleGetAuthStatus());
  ipcMain.handle('start-github-login', async () => handleStartGitHubLogin());
  ipcMain.handle('poll-github-token', async (_, data) => handlePollGitHubToken(data.deviceCode, data.interval));
  ipcMain.handle('login-with-github-pat', async (_, token) => handleLoginWithPat(token));
  ipcMain.handle('logout', () => handleLogout());
  ipcMain.handle('open-url', (_, url) => shell.openExternal(url));
  ipcMain.handle('save-ai-config', (_, config) => handleSaveAiConfig(config));
  ipcMain.handle('load-ai-config', () => handleLoadAiConfig());

  ipcMain.handle('load-presentation-config', () => loadPresentationConfig());
  ipcMain.handle('save-presentation-config', (_, config) => savePresentationConfig(config));
  ipcMain.handle('test-presentation-tts', (_, config) => testPresentationTts(config));
  ipcMain.handle('select-repo-images', async (_, payload = {}) => {
    const repoName = typeof payload.repoName === 'string' ? payload.repoName.trim() : '';
    const currentPaths = Array.isArray(payload.currentPaths) ? payload.currentPaths.filter(Boolean) : [];
    const defaultPath = currentPaths.length > 0 ? path.dirname(currentPaths[0]) : undefined;

    const result = await dialog.showOpenDialog(mainWindow, {
      title: repoName ? `选择 ${repoName} 的图片` : '选择仓库图片',
      defaultPath,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled) {
      return {
        ok: false,
        canceled: true,
        filePaths: currentPaths,
      };
    }

    return {
      ok: true,
      canceled: false,
      filePaths: result.filePaths || [],
    };
  });
  ipcMain.handle('select-presentation-manifest', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择播放清单 JSON',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    try {
      const manifest = loadPresentationManifest(result.filePaths[0]);
      return {
        ok: true,
        path: manifest.path,
        content: manifest.content,
      };
    } catch (error) {
      return {
        ok: false,
        message: error.message,
      };
    }
  });
  ipcMain.handle('prepare-presentation-session', async (event, payload) => {
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('presentation-progress', progress);
      }
    };

    return preparePresentationSession(payload, sendProgress);
  });

  ipcMain.handle('minimize', () => mainWindow.minimize());
  ipcMain.handle('maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('close', () => mainWindow.close());

  ipcMain.handle('fetch-repos', async (_, config) => handleFetchRepos(config, mainWindow));
  ipcMain.handle('analyze-repos', async (_, data) => handleAnalyzeWithAI(data.aiConfig, data.repos, mainWindow));
  ipcMain.handle('fetch-selected-readmes', async (_, payload) => {
    const result = await handleFetchSelectedReadmes(payload);
    if (result?.ok && result.entryHtmlPath) {
      const openError = await shell.openPath(result.entryHtmlPath);
      return {
        ...result,
        openedEntry: !openError,
        message: openError
          ? `${result.message}，但浏览器打开失败：${openError}`
          : result.message,
      };
    }
    return result;
  });
  ipcMain.handle('test-connection', async (_, aiConfig) => handleTestConnection(aiConfig));

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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
