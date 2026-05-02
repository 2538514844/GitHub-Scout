const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
let ffmpegStaticPath = '';
try {
  ffmpegStaticPath = require('ffmpeg-static') || '';
} catch {
  ffmpegStaticPath = '';
}
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
  handleLoadEmailPushConfig,
  handleSaveEmailPushConfig,
  handleEmailPushTestSmtp,
  handleEmailPushSend,
  handleEmailPushCrawl,
  handlePushRssUpload,
  handleLoadGlobalSmtp,
  handleSaveGlobalSmtp,
  handleTestGlobalSmtp,
  handlePushGlobalRssUpload,
  handleLoadGlobalRss,
  handleSaveGlobalRss,
  handleGenerateDailyArticle,
  handleLoadAllPrompts,
  handleSavePrompt,
  handleResetPrompt,
  handleGetPromptHistory,
  handleRollbackPrompt,
  patchLatestCarouselFooterFontSize,
  handleLoadRepoHistory,
  logEmitter,
} = require('./ipc');
const {
  loadPresentationConfig,
  savePresentationConfig,
  preparePresentationSession,
  loadPresentationManifest,
  findLatestCarouselManifest,
  buildPlaylistFromCarouselManifest,
  testPresentationTts,
} = require('./presentation');

let mainWindow;
let recorderWindow;

function emitRecorderLog(level, message) {
  logEmitter.emit('log', {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    message: `[录制] ${message}`,
  });
}

function normalizeVideoBytes(payload = {}) {
  const raw = payload.fileData || payload.buffer || payload.data;
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw));
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Buffer.from(raw);
  if (Array.isArray(raw.data)) return Buffer.from(raw.data);
  return null;
}

function replaceExtension(filePath, extension) {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${normalizedExtension}`);
}

function resolveFfmpegPath() {
  if (!ffmpegStaticPath) return '';
  const unpackedPath = ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
  return [ffmpegStaticPath, unpackedPath].find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function buildTempRecordingPath(targetPath) {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `${parsed.name}.source-${Date.now()}.webm`);
}

function transcodeToMp4(sourcePath, targetPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error('没有找到 ffmpeg 转码器，请重新执行 npm install。'));
      return;
    }

    // 优先 NVENC 硬件加速，失败时回退 CPU 软编码
    const nvencArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p4',
      '-cq',
      '18',
      '-rc',
      'vbr_hq',
      '-maxrate',
      '24000k',
      '-bufsize',
      '48000k',
      '-g',
      '60',
      '-vf',
      'scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2',
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      '-movflags',
      '+faststart',
      targetPath,
    ];

    const cpuArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-maxrate',
      '24000k',
      '-bufsize',
      '48000k',
      '-g',
      '60',
      '-vf',
      'scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2',
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      '-movflags',
      '+faststart',
      targetPath,
    ];

    const runFfmpeg = (args, label) => new Promise((res, rej) => {
      let stderr = '';
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const timeMatch = text.match(/out_time_us=(\d+)/);
        if (timeMatch) {
          const seconds = Number(timeMatch[1]) / 1000000;
          logEmitter.emit('log', { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'info', message: `[录制] 转码进度(${label}): ${seconds.toFixed(0)} 秒` });
        }
      });
      child.on('error', rej);
      child.on('close', (code) => {
        if (code === 0) res();
        else rej(new Error(stderr.trim() || `ffmpeg 转码失败(${label})，退出码 ${code}`));
      });
    });

    (async () => {
      try {
        await runFfmpeg(nvencArgs, 'NVENC');
        resolve();
      } catch (nvencErr) {
        logEmitter.emit('log', { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'warn', message: `[录制] NVENC 失败，回退 CPU 编码: ${nvencErr.message}` });
        try {
          await runFfmpeg(cpuArgs, 'CPU');
          resolve();
        } catch (cpuErr) {
          reject(cpuErr);
        }
      }
    })();
  });
}

function closeRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.close();
  }
  recorderWindow = null;
}

async function openReadmeRecorderWindow(entryHtmlPath) {
  const resolvedPath = path.resolve(String(entryHtmlPath || ''));
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error('录制入口 HTML 不存在，请先重新生成 README HTML 轮播。');
  }

  closeRecorderWindow();

  const partitionName = `readme-recorder-${Date.now()}`;
  const recorderSession = session.fromPartition(partitionName);

  recorderSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'display-capture' || permission === 'media');
  });
  recorderSession.setPermissionCheckHandler((webContents, permission) => (
    permission === 'display-capture' || permission === 'media'
  ));

  recorderSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request?.frame || !request.videoRequested) {
      emitRecorderLog('error', '无法获取录制窗口的视频 frame');
      callback({});
      return;
    }

    const streams = {
      video: request.frame,
      enableLocalEcho: true,
    };
    if (request.audioRequested) {
      streams.audio = request.frame;
    }
    callback(streams);
  }, { useSystemPicker: false });

  recorderWindow = new BrowserWindow({
    title: 'GitHub Scout Recorder',
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'recorder-preload.cjs'),
      partition: partitionName,
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  recorderWindow.once('ready-to-show', () => {
    if (!recorderWindow || recorderWindow.isDestroyed()) return;
    recorderWindow.show();
    recorderWindow.focus();
  });

  recorderWindow.on('closed', () => {
    recorderSession.setDisplayMediaRequestHandler(null);
    recorderWindow = null;
  });

  await recorderWindow.loadFile(resolvedPath);

  return {
    ok: true,
    entryHtmlPath: resolvedPath,
  };
}

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
  ipcMain.handle('open-local-path', (_, targetPath) => shell.openPath(String(targetPath || '')));
  ipcMain.handle('open-readme-recorder', async (_, payload = {}) => {
    return openReadmeRecorderWindow(payload.entryHtmlPath);
  });
  ipcMain.handle('close-current-window', (event) => {
    const currentWindow = BrowserWindow.fromWebContents(event.sender);
    currentWindow?.close();
    return { ok: true };
  });
  ipcMain.handle('recorder-log', (_, entry) => {
    if (entry?.message) {
      logEmitter.emit('log', entry);
    }
  });

  ipcMain.handle('save-recorded-video', async (event, payload = {}) => {
    const currentWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const requestedDefaultPath = typeof payload.defaultPath === 'string' && payload.defaultPath.trim()
      ? payload.defaultPath.trim()
      : path.join(app.getPath('videos'), 'github-scout-recording.webm');
    const wantsMp4 = payload.outputFormat === 'mp4' || /\.mp4$/i.test(requestedDefaultPath);
    const defaultPath = wantsMp4 ? replaceExtension(requestedDefaultPath, 'mp4') : requestedDefaultPath;
    const fileBytes = normalizeVideoBytes(payload);
    const skipDialog = payload.skipDialog === true;

    if (!fileBytes || fileBytes.length === 0) {
      emitRecorderLog('error', '保存失败：录制数据为空');
      return {
        ok: false,
        canceled: false,
        message: '录制数据为空，未生成视频文件。',
      };
    }

    if (skipDialog) {
      fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
      if (wantsMp4) {
        const tempPath = buildTempRecordingPath(defaultPath);
        fs.writeFileSync(tempPath, fileBytes);
        emitRecorderLog('info', `正在转码 MP4: ${defaultPath}`);
        try {
          await transcodeToMp4(tempPath, defaultPath);
        } finally {
          fs.rmSync(tempPath, { force: true });
        }
      } else {
        fs.writeFileSync(defaultPath, fileBytes);
      }
      emitRecorderLog('success', `视频已保存到: ${defaultPath}`);
      return {
        ok: true,
        canceled: false,
        filePath: defaultPath,
      };
    }

    const extension = path.extname(defaultPath).replace(/^\./, '').toLowerCase() || (wantsMp4 ? 'mp4' : 'webm');
    const saveResult = await dialog.showSaveDialog(currentWindow, {
      title: '保存录制视频',
      defaultPath,
      filters: [
        { name: extension.toUpperCase(), extensions: [extension] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: true,
        canceled: true,
      };
    }

    const selectedPath = wantsMp4 ? replaceExtension(saveResult.filePath, 'mp4') : saveResult.filePath;
    if (wantsMp4) {
      fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
      const tempPath = buildTempRecordingPath(selectedPath);
      fs.writeFileSync(tempPath, fileBytes);
      emitRecorderLog('info', `正在转码 MP4: ${selectedPath}`);
      try {
        await transcodeToMp4(tempPath, selectedPath);
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
    } else {
      fs.writeFileSync(selectedPath, fileBytes);
    }
    emitRecorderLog('success', `视频已保存到: ${selectedPath}`);
    return {
      ok: true,
      canceled: false,
      filePath: selectedPath,
    };
  });
  ipcMain.handle('save-ai-config', (_, config) => handleSaveAiConfig(config));
  ipcMain.handle('load-ai-config', () => handleLoadAiConfig());

  ipcMain.handle('load-presentation-config', () => loadPresentationConfig());
  ipcMain.handle('load-repo-history', (_, page = 1, pageSize = 200) => handleLoadRepoHistory(page, pageSize));
  ipcMain.handle('save-presentation-config', (_, config) => {
    const saved = savePresentationConfig(config);
    const fontSize = typeof config.repoFooterFontSize === 'number' ? config.repoFooterFontSize : 14;
    patchLatestCarouselFooterFontSize(fontSize);
    return saved;
  });
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
  ipcMain.handle('load-latest-carousel-manifest', async () => {
    try {
      const manifestPath = findLatestCarouselManifest();
      if (!manifestPath) {
        return { ok: false, notFound: true };
      }
      const playlist = buildPlaylistFromCarouselManifest(manifestPath);
      return {
        ok: true,
        path: manifestPath,
        content: JSON.stringify(playlist, null, 2),
      };
    } catch (error) {
      return { ok: false, message: error.message };
    }
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
  ipcMain.handle('fetch-selected-readmes', async (_, payload) => handleFetchSelectedReadmes(payload));
  ipcMain.handle('test-connection', async (_, aiConfig) => handleTestConnection(aiConfig));

  ipcMain.handle('push-email-load-config', () => handleLoadEmailPushConfig());
  ipcMain.handle('push-email-save-config', (_, config) => handleSaveEmailPushConfig(config));
  ipcMain.handle('push-email-test-smtp', (_, smtpConfig) => handleEmailPushTestSmtp(smtpConfig));
  ipcMain.handle('push-email-send', (_, payload) => handleEmailPushSend(payload));
  ipcMain.handle('push-email-crawl', (_, payload) => handleEmailPushCrawl(payload, mainWindow));
  ipcMain.handle('push-rss-upload', (_, payload) => handlePushRssUpload(payload));

  // Global SMTP settings
  ipcMain.handle('push-global-smtp-load', () => handleLoadGlobalSmtp());
  ipcMain.handle('push-global-smtp-save', (_, smtpConfig) => handleSaveGlobalSmtp(smtpConfig));
  ipcMain.handle('push-global-smtp-test', (_, smtpConfig) => handleTestGlobalSmtp(smtpConfig));

  // Global RSS settings
  ipcMain.handle('push-global-rss-load', () => handleLoadGlobalRss());
  ipcMain.handle('push-global-rss-save', (_, rssConfig) => handleSaveGlobalRss(rssConfig));
  ipcMain.handle('push-global-rss-upload', (_, payload) => handlePushGlobalRssUpload(payload));
  ipcMain.handle('generate-daily-article', (_, payload) => handleGenerateDailyArticle(payload));

  ipcMain.handle('load-all-prompts', () => handleLoadAllPrompts());
  ipcMain.handle('save-prompt', (_, key, text) => handleSavePrompt(key, text));
  ipcMain.handle('reset-prompt', (_, key) => handleResetPrompt(key));
  ipcMain.handle('get-prompt-history', (_, key) => handleGetPromptHistory(key));
  ipcMain.handle('rollback-prompt', (_, key, versionIndex) => handleRollbackPrompt(key, versionIndex));

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
