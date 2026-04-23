const { ipcRenderer } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');

const OVERLAY_ID = 'github-scout-recorder-overlay';
const STYLE_ID = 'github-scout-recorder-style';

let mediaRecorder = null;
let activeStream = null;
let recordedChunks = [];
let lastRecordedBlob = null;
let lastRecordedMimeType = '';
let recordingBootstrapping = false;
let stopRequested = false;
let isSaving = false;
let pageStartHooked = false;
let pagePlaybackStarted = false;
let firstPageRecordingRequested = false;

let statusTextNode = null;
let tipTextNode = null;
let startFallbackButton = null;
let stopButton = null;
let saveAgainButton = null;

function pickSupportedRecordingFormat() {
  const candidates = [
    { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
    { mimeType: 'video/webm', extension: 'webm' },
    { mimeType: 'video/mp4', extension: 'mp4' },
    { mimeType: '', extension: 'webm' },
  ];

  if (typeof MediaRecorder === 'undefined') {
    return candidates[candidates.length - 1];
  }

  return candidates.find((item) => !item.mimeType || MediaRecorder.isTypeSupported(item.mimeType))
    || candidates[candidates.length - 1];
}

function inferExtensionFromMimeType(mimeType = '') {
  if (/mp4/i.test(mimeType)) return 'mp4';
  return 'webm';
}

function sendLog(level, message) {
  ipcRenderer.invoke('recorder-log', {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    message: `[录制] ${message}`,
  }).catch(() => {});
}

function getCurrentHtmlPath() {
  try {
    return fileURLToPath(window.location.href);
  } catch {
    return '';
  }
}

function buildDefaultSavePath(mimeType = '', outputFormat = '') {
  const htmlPath = getCurrentHtmlPath();
  const outputDir = htmlPath ? path.dirname(htmlPath) : process.cwd();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = outputFormat === 'mp4' ? 'mp4' : inferExtensionFromMimeType(mimeType);
  return path.join(outputDir, `recording-${timestamp}.${extension}`);
}

function ensureRecorderStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 36px));
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(9, 12, 18, 0.78);
      color: #f3f6fb;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    #${OVERLAY_ID}[data-state="recording"] {
      border-color: rgba(255, 98, 98, 0.42);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 98, 98, 0.18);
    }

    #${OVERLAY_ID} .recorder-kicker {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.62);
      margin-bottom: 6px;
    }

    #${OVERLAY_ID} .recorder-status {
      font-size: 14px;
      line-height: 1.5;
      font-weight: 600;
      margin-bottom: 6px;
    }

    #${OVERLAY_ID} .recorder-tip {
      font-size: 12px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.78);
      margin-bottom: 12px;
    }

    #${OVERLAY_ID} .recorder-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    #${OVERLAY_ID} button {
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 9px 14px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease, color 120ms ease;
    }

    #${OVERLAY_ID} button:hover {
      transform: translateY(-1px);
    }

    #${OVERLAY_ID} button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }

    #${OVERLAY_ID} .primary {
      background: #f3f6fb;
      color: #0b1220;
    }

    #${OVERLAY_ID} .danger {
      background: #ff6363;
      color: #ffffff;
    }

    #${OVERLAY_ID} .ghost {
      background: rgba(255, 255, 255, 0.08);
      color: #f3f6fb;
      border: 1px solid rgba(255, 255, 255, 0.14);
    }
  `;

  document.head.appendChild(style);
}

function setOverlayState(state) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.dataset.state = state;
  }
}

function setOverlayVisibility(visible) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.style.opacity = visible ? '1' : '0';
  overlay.style.pointerEvents = visible ? 'auto' : 'none';
}

function updateStatus(status, tip = '') {
  if (statusTextNode) {
    statusTextNode.textContent = status;
  }
  if (tipTextNode) {
    tipTextNode.textContent = tip;
  }
}

function renderOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  ensureRecorderStyles();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.dataset.state = 'idle';
  overlay.innerHTML = `
    <div class="recorder-kicker">Full Screen Recorder</div>
    <div class="recorder-status"></div>
    <div class="recorder-tip"></div>
    <div class="recorder-actions">
      <button type="button" class="primary recorder-start-fallback" hidden>开始录制</button>
      <button type="button" class="danger recorder-stop" disabled>停止并保存</button>
      <button type="button" class="ghost recorder-save-again" hidden>重新保存</button>
      <button type="button" class="ghost recorder-close">关闭窗口</button>
    </div>
  `;

  document.body.appendChild(overlay);

  statusTextNode = overlay.querySelector('.recorder-status');
  tipTextNode = overlay.querySelector('.recorder-tip');
  startFallbackButton = overlay.querySelector('.recorder-start-fallback');
  stopButton = overlay.querySelector('.recorder-stop');
  saveAgainButton = overlay.querySelector('.recorder-save-again');
  const closeButton = overlay.querySelector('.recorder-close');

  startFallbackButton.addEventListener('click', async () => {
    const startedRecording = await beginRecording();
    if (startedRecording && !pagePlaybackStarted) {
      triggerPageStartButton();
    }
  });

  stopButton.addEventListener('click', async () => {
    await stopRecording({ autoSaveLabel: '正在停止录制并保存视频...' });
  });

  saveAgainButton.addEventListener('click', async () => {
    if (!lastRecordedBlob) return;
    await saveRecordingBlob(lastRecordedBlob, lastRecordedMimeType, { skipDialog: false, outputFormat: 'mp4' });
  });

  closeButton.addEventListener('click', () => {
    if (isSaving) {
      updateStatus('正在保存中', '请等待视频保存完成后再关闭窗口...');
      return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      stopRecording({ autoSaveLabel: '正在停止录制并保存视频...' }).catch(() => {});
      return;
    }
    ipcRenderer.invoke('close-current-window').catch(() => {});
  });

  setOverlayVisibility(true);
}

function cleanupStream() {
  if (!activeStream) return;
  activeStream.getTracks().forEach((track) => track.stop());
  activeStream = null;
}

function triggerPageStartButton() {
  const startButton = document.getElementById('start-button');
  if (!startButton) return false;

  pagePlaybackStarted = true;
  startButton.click();
  return true;
}

async function saveRecordingBlob(blob, mimeType = '', options = {}) {
  const outputFormat = options.outputFormat || 'mp4';
  const defaultPath = buildDefaultSavePath(mimeType, outputFormat);
  const skipDialog = options.skipDialog !== false;

  try {
    const arrayBuffer = await blob.arrayBuffer();
    sendLog(
      'info',
      (skipDialog ? '正在自动保存视频: ' : '正在打开保存对话框: ')
        + defaultPath
        + '，数据大小: '
        + (arrayBuffer.byteLength / 1024 / 1024).toFixed(2)
        + ' MB',
    );
    const saveResult = await ipcRenderer.invoke('save-recorded-video', {
      defaultPath,
      fileData: arrayBuffer,
      skipDialog,
      outputFormat,
    });

    if (!saveResult?.ok) {
      updateStatus('保存失败', saveResult?.message || '视频文件写入失败，请重试。');
      saveAgainButton.hidden = false;
      sendLog('error', '录制视频保存失败: ' + (saveResult?.message || '未知错误'));
      return saveResult;
    }

    if (saveResult.canceled) {
      updateStatus('已停止录制', '你取消了保存；可以点击”重新保存”再次导出。');
      saveAgainButton.hidden = false;
      sendLog('warn', '录制视频保存已取消');
      return saveResult;
    }

    saveAgainButton.hidden = true;
    updateStatus('视频已保存', saveResult.filePath || '录制文件已写入磁盘。');
    sendLog('success', '录制视频已保存: ' + (saveResult.filePath || '位置未知'));
    return saveResult;
  } catch (err) {
    updateStatus('保存失败', err?.message || '保存视频时发生未知错误。');
    saveAgainButton.hidden = false;
    sendLog('error', '保存视频异常: ' + (err?.message || '未知错误'));
    return { ok: false, message: err?.message || '保存失败' };
  }
}

async function beginRecording() {
  if (recordingBootstrapping || (mediaRecorder && mediaRecorder.state !== 'inactive')) {
    return Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
  }

  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    updateStatus('当前环境不支持录制', '这个窗口无法调用浏览器录屏能力。');
    startFallbackButton.hidden = false;
    sendLog('error', '当前环境不支持 getDisplayMedia');
    return false;
  }

  recordingBootstrapping = true;
  stopRequested = false;
  saveAgainButton.hidden = true;
  updateStatus('正在准备录制...', '窗口已经全屏，无需再按 F11。');
  sendLog('info', '正在请求屏幕共享...');

  try {
    const chosenFormat = pickSupportedRecordingFormat();
    sendLog('info', '首选录制格式: ' + (chosenFormat.mimeType || '浏览器默认'));

    // 15 秒超时，防止 getDisplayMedia 挂起导致用户无反馈
    const stream = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('屏幕共享请求超时(15秒)，可能是 setDisplayMediaRequestHandler 不兼容')), 15000)
      ),
    ]);

    activeStream = stream;
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    if (videoTracks.length > 0) {
      const vt = videoTracks[0];
      const settings = vt.getSettings ? vt.getSettings() : {};
      sendLog('info', '视频轨道: ' + vt.label + ', 分辨率=' + (settings.width || '?') + 'x' + (settings.height || '?') + ', 帧率=' + (settings.frameRate || '?'));
    }
    if (audioTracks.length > 0) {
      sendLog('info', '音频轨道: ' + audioTracks[0].label);
    } else {
      sendLog('warn', '未获取到音频轨道，录制视频可能没有声音');
    }
    sendLog('info', '屏幕共享已获取: 视频轨道 ' + videoTracks.length + ', 音频轨道 ' + audioTracks.length);

    if (videoTracks.length === 0) {
      cleanupStream();
      mediaRecorder = null;
      recordingBootstrapping = false;
      setOverlayVisibility(true);
      updateStatus('录制启动失败', '未获取到视频轨道，可能是 setDisplayMediaRequestHandler 未提供视频源');
      startFallbackButton.hidden = false;
      sendLog('error', '未获取到视频轨道');
      return false;
    }

    recordedChunks = [];
    lastRecordedBlob = null;
    lastRecordedMimeType = chosenFormat.mimeType || 'video/webm';

    const recorderOptions = chosenFormat.mimeType
      ? {
        mimeType: chosenFormat.mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 192_000,
      }
      : {
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 192_000,
      };

    mediaRecorder = new MediaRecorder(stream, recorderOptions);
    sendLog('info', 'MediaRecorder 已创建，状态: ' + mediaRecorder.state + '，MIME: ' + (mediaRecorder.mimeType || '未知'));
    mediaRecorder.addEventListener('error', (event) => {
      sendLog('error', 'MediaRecorder 错误: ' + (event.error?.message || '未知错误'));
      setOverlayVisibility(true);
      updateStatus('录制出错', event.error?.message || 'MediaRecorder 发生错误');
    });
    let lastChunkLogTime = 0;
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
        const now = Date.now();
        if (now - lastChunkLogTime > 5000) {
          lastChunkLogTime = now;
          const totalSize = recordedChunks.reduce((sum, c) => sum + c.size, 0);
          sendLog('info', `已收集 ${recordedChunks.length} 个数据块，累计 ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        }
      }
    });

    mediaRecorder.addEventListener('stop', async () => {
      const totalSize = recordedChunks.reduce((sum, c) => sum + c.size, 0);
      sendLog('info', `录制停止，共 ${recordedChunks.length} 个数据块，总大小 ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
      const blob = new Blob(recordedChunks, {
        type: mediaRecorder?.mimeType || lastRecordedMimeType || 'video/webm',
      });
      lastRecordedBlob = blob;
      lastRecordedMimeType = blob.type || lastRecordedMimeType || 'video/webm';
      cleanupStream();
      mediaRecorder = null;
      setOverlayState('idle');
      setOverlayVisibility(true);
      stopButton.disabled = true;
      recordingBootstrapping = false;
      try {
        isSaving = true;
        await saveRecordingBlob(blob, lastRecordedMimeType);
      } catch (error) {
        updateStatus('保存失败', error?.message || '保存视频时发生未知错误。');
        saveAgainButton.hidden = false;
        sendLog('error', '保存录制视频失败: ' + (error?.message || '未知错误'));
      } finally {
        isSaving = false;
      }
    });

    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (!stopRequested) {
          stopRecording({ autoSaveLabel: '录制源已结束，正在保存视频...' }).catch(() => {});
        }
      });
    });

    setOverlayVisibility(false);
    mediaRecorder.start(1000);
    sendLog('success', 'MediaRecorder 已启动，timeslice=1000ms，实际 MIME: ' + mediaRecorder.mimeType);
    setOverlayState('recording');
    stopButton.disabled = false;
    startFallbackButton.hidden = true;
    const formatLabel = chosenFormat.mimeType || 'video/webm';
    updateStatus('录制中', '录制过程中按 Ctrl+Shift+S 可以提前停止并保存。');
    sendLog('success', `录制已开始，格式: ${formatLabel}，保存到: ${buildDefaultSavePath(formatLabel, 'mp4')}`);
    return true;
  } catch (error) {
    cleanupStream();
    mediaRecorder = null;
    setOverlayVisibility(true);
    updateStatus('录制启动失败', error?.message || '无法开始录制，请再试一次。');
    startFallbackButton.hidden = false;
    sendLog('error', '录制启动失败: ' + (error?.message || '无法开始录制'));
    return false;
  } finally {
    recordingBootstrapping = false;
  }
}

async function stopRecording({ autoSaveLabel = '正在保存视频...' } = {}) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive' || stopRequested) {
    return;
  }

  stopRequested = true;
  stopButton.disabled = true;
  updateStatus('正在停止录制...', autoSaveLabel);
  mediaRecorder.stop();
}

function hookPageStartButton() {
  const startButton = document.getElementById('start-button');
  if (!startButton) {
    startFallbackButton.hidden = false;
    updateStatus('录制窗口已就绪', '没有检测到页面内的开始按钮，你也可以直接点击这里的“开始录制”。');
    return;
  }

  if (pageStartHooked) return;
  pageStartHooked = true;
  startFallbackButton.hidden = true;
  updateStatus('录制窗口已就绪', '窗口已经全屏。点击页面中央的开始播放按钮后，会在第一页加载完成时自动开始录制；录制中可按 Ctrl+Shift+S 提前保存。');

  startButton.addEventListener('click', () => {
    pagePlaybackStarted = true;
    updateStatus('等待第一页加载', '第一页 HTML 加载完成后会自动开始录制。');
    sendLog('info', '已点击开始播放，等待第一页加载完成后启动录制');
  }, { capture: true });
}

function bindRecorderLifecycleEvents() {
  window.addEventListener('github-scout:page-change', (event) => {
    const currentIndex = Number(event.detail?.currentIndex ?? -1);
    if (currentIndex !== 0 || !pagePlaybackStarted || firstPageRecordingRequested) {
      return;
    }

    firstPageRecordingRequested = true;
    updateStatus('第一页已加载', '正在从完整画面开始录制...');
    sendLog('info', '第一页 HTML 已加载完成，开始启动录制');
    beginRecording()
      .then((startedRecording) => {
        window.dispatchEvent(new CustomEvent(
          startedRecording ? 'github-scout:recorder-started' : 'github-scout:recorder-skipped',
        ));
      })
      .catch((error) => {
        sendLog('error', '第一页加载后启动录制失败: ' + (error?.message || '未知错误'));
        window.dispatchEvent(new CustomEvent('github-scout:recorder-skipped'));
      });
  });

  window.addEventListener('github-scout:carousel-complete', () => {
    stopRecording({ autoSaveLabel: '轮播已结束，正在自动保存视频...' }).catch(() => {});
  });

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      stopRecording({ autoSaveLabel: '正在停止录制并保存视频...' }).catch(() => {});
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (isSaving) return;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        stopRecording({ autoSaveLabel: 'Saving recording before closing...' }).catch(() => {});
        return;
      }
      ipcRenderer.invoke('close-current-window').catch(() => {});
    }
  });
}

function bootstrapRecorderOverlay() {
  renderOverlay();
  hookPageStartButton();
  bindRecorderLifecycleEvents();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapRecorderOverlay, { once: true });
} else {
  bootstrapRecorderOverlay();
}
