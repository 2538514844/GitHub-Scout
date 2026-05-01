import React, { useEffect, useMemo, useState } from 'react';
import PresentationPlayerOverlay from './PresentationPlayerOverlay';

const DEFAULT_PLAYLIST = `{
  "items": [
    {
      "title": "页面 1",
      "htmlPath": "C:\\\\path\\\\to\\\\page-1.html",
      "ttsText": "这里填写页面一的解说词。",
      "pageReadyDelayMs": 800,
      "holdAfterAudioMs": 400
    },
    {
      "title": "页面 2",
      "url": "https://example.com",
      "ttsText": "这里填写页面二的解说词。",
      "pageReadyDelayMs": 800,
      "holdAfterAudioMs": 400
    }
  ]
}`;

const DEFAULT_CONFIG = {
  tts: {
    apiUrl: 'https://api.minimaxi.com/v1/t2a_v2',
    apiKey: '',
    model: 'speech-2.8-hd',
    voiceId: 'male-qn-qingse',
    speed: 1,
    volume: 1,
    pitch: 0,
    emotion: '',
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  },
  player: {
    pageReadyDelayMs: 600,
    holdAfterAudioMs: 300,
    pageLoadTimeoutMs: 8000,
  },
  repoFooterFontSize: 14,
  playlistText: DEFAULT_PLAYLIST,
};

function PresentationStudio() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [progress, setProgress] = useState(null);
  const [session, setSession] = useState(null);

  useEffect(() => {
    let disposed = false;

    const loadConfig = async () => {
      try {
        const saved = await window.electronAPI.loadPresentationConfig();
        if (!disposed && saved) {
          setConfig({
            tts: { ...DEFAULT_CONFIG.tts, ...(saved.tts || {}) },
            player: { ...DEFAULT_CONFIG.player, ...(saved.player || {}) },
            repoFooterFontSize: saved.repoFooterFontSize ?? DEFAULT_CONFIG.repoFooterFontSize,
            playlistText: saved.playlistText || DEFAULT_PLAYLIST,
          });
        }
      } catch (error) {
        if (!disposed) {
          setErrorMessage(error.message || '播放器配置加载失败。');
        }
      } finally {
        if (!disposed) {
          setLoadingConfig(false);
        }
      }
    };

    loadConfig();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI.onPresentationProgress((nextProgress) => {
      setProgress(nextProgress);
    });
    return () => {
      dispose?.();
    };
  }, []);

  const progressLabel = useMemo(() => {
    if (!progress) return '';
    if (progress.stage === 'start') return `共 ${progress.total} 条网页，正在准备语音。`;
    if (progress.stage === 'tts') return `正在生成语音 ${progress.current}/${progress.total}：${progress.title}`;
    if (progress.stage === 'prepared-item') {
      return progress.cached
        ? `已复用缓存 ${progress.completed}/${progress.total}：${progress.title}`
        : `已完成 ${progress.completed}/${progress.total}：${progress.title}`;
    }
    if (progress.stage === 'done') return '全部 TTS 已准备完成，正在进入播放器。';
    return '';
  }, [progress]);

  const updateTtsField = (field, value) => {
    setConfig((current) => ({
      ...current,
      tts: {
        ...current.tts,
        [field]: value,
      },
    }));
  };

  const updatePlayerField = (field, value) => {
    setConfig((current) => ({
      ...current,
      player: {
        ...current.player,
        [field]: value,
      },
    }));
  };

  const persistConfig = async (nextConfig = config) => {
    setSaving(true);
    setErrorMessage('');
    setSaveMessage('');

    try {
      await window.electronAPI.savePresentationConfig(nextConfig);
      setSaveMessage('播放器配置已保存。');
      return true;
    } catch (error) {
      setErrorMessage(error.message || '播放器配置保存失败。');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handlePickManifest = async () => {
    setErrorMessage('');

    try {
      const result = await window.electronAPI.selectPresentationManifest();
      if (!result?.ok) {
        if (!result?.canceled && result?.message) {
          setErrorMessage(result.message);
        }
        return;
      }

      setConfig((current) => ({
        ...current,
        playlistText: result.content || DEFAULT_PLAYLIST,
      }));
      setSaveMessage(`已载入清单：${result.path}`);
    } catch (error) {
      setErrorMessage(error.message || '清单读取失败。');
    }
  };

  const handleSave = async () => {
    await persistConfig(config);
  };

  const handlePrepareAndStart = async () => {
    setPreparing(true);
    setErrorMessage('');
    setSaveMessage('');
    setProgress(null);

    const nextConfig = {
      ...config,
      playlistText: config.playlistText || DEFAULT_PLAYLIST,
    };

    const saved = await persistConfig(nextConfig);
    if (!saved) {
      setPreparing(false);
      return;
    }

    try {
      const parsedPlaylist = JSON.parse(nextConfig.playlistText);
      const prepared = await window.electronAPI.preparePresentationSession({
        playlist: parsedPlaylist,
        ttsConfig: nextConfig.tts,
        playerConfig: nextConfig.player,
      });

      setSession(prepared);
      setSaveMessage('');
    } catch (error) {
      setErrorMessage(error.message || '预加载失败。');
    } finally {
      setPreparing(false);
    }
  };

  if (loadingConfig) {
    return (
      <div className="presentation-section">
        <div className="presentation-empty">正在加载固定播放器配置...</div>
      </div>
    );
  }

  return (
    <>
      <div className="presentation-section">
        <div className="presentation-header">
          <div>
            <h3>固定网页播放器</h3>
            <p>先生成并缓存全部 MiniMax TTS，再进入网页轮播界面。</p>
          </div>
          <div className="presentation-actions">
            <button onClick={handlePickManifest}>载入清单文件</button>
            <button onClick={handleSave} disabled={saving || preparing}>
              {saving ? '保存中...' : '保存配置'}
            </button>
            <button
              className="presentation-primary"
              onClick={handlePrepareAndStart}
              disabled={preparing}
            >
              {preparing ? '正在预加载...' : '预加载 TTS 并开始'}
            </button>
          </div>
        </div>

        <div className="presentation-grid">
          <div className="presentation-card">
            <div className="presentation-card-title">MiniMax TTS</div>
            <label>
              <span>API URL</span>
              <input
                type="text"
                value={config.tts.apiUrl}
                onChange={(event) => updateTtsField('apiUrl', event.target.value)}
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={config.tts.apiKey}
                onChange={(event) => updateTtsField('apiKey', event.target.value)}
                placeholder="Bearer API Key"
              />
            </label>
            <div className="presentation-row">
              <label>
                <span>Model</span>
                <input
                  type="text"
                  value={config.tts.model}
                  onChange={(event) => updateTtsField('model', event.target.value)}
                />
              </label>
              <label>
                <span>Voice ID</span>
                <input
                  type="text"
                  value={config.tts.voiceId}
                  onChange={(event) => updateTtsField('voiceId', event.target.value)}
                />
              </label>
            </div>
            <div className="presentation-row">
              <label>
                <span>Speed</span>
                <input
                  type="number"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={config.tts.speed}
                  onChange={(event) => updateTtsField('speed', Number(event.target.value))}
                />
              </label>
              <label>
                <span>Volume</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={config.tts.volume}
                  onChange={(event) => updateTtsField('volume', Number(event.target.value))}
                />
              </label>
              <label>
                <span>Pitch</span>
                <input
                  type="number"
                  min="-12"
                  max="12"
                  step="1"
                  value={config.tts.pitch}
                  onChange={(event) => updateTtsField('pitch', Number(event.target.value))}
                />
              </label>
            </div>
            <div className="presentation-row">
              <label>
                <span>Emotion</span>
                <input
                  type="text"
                  value={config.tts.emotion}
                  onChange={(event) => updateTtsField('emotion', event.target.value)}
                  placeholder="可留空"
                />
              </label>
              <label>
                <span>Sample Rate</span>
                <input
                  type="number"
                  min="8000"
                  max="48000"
                  step="1000"
                  value={config.tts.sampleRate}
                  onChange={(event) => updateTtsField('sampleRate', Number(event.target.value))}
                />
              </label>
              <label>
                <span>Bitrate</span>
                <input
                  type="number"
                  min="32000"
                  max="320000"
                  step="1000"
                  value={config.tts.bitrate}
                  onChange={(event) => updateTtsField('bitrate', Number(event.target.value))}
                />
              </label>
            </div>
          </div>

          <div className="presentation-card">
            <div className="presentation-card-title">播放器默认参数</div>
            <div className="presentation-row">
              <label>
                <span>页面稳定延迟 (ms)</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="100"
                  value={config.player.pageReadyDelayMs}
                  onChange={(event) => updatePlayerField('pageReadyDelayMs', Number(event.target.value))}
                />
              </label>
              <label>
                <span>音频结束后停留 (ms)</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="100"
                  value={config.player.holdAfterAudioMs}
                  onChange={(event) => updatePlayerField('holdAfterAudioMs', Number(event.target.value))}
                />
              </label>
              <label>
                <span>页面载入超时 (ms)</span>
                <input
                  type="number"
                  min="1000"
                  max="30000"
                  step="500"
                  value={config.player.pageLoadTimeoutMs}
                  onChange={(event) => updatePlayerField('pageLoadTimeoutMs', Number(event.target.value))}
                />
              </label>
            </div>

            <div className="presentation-row" style={{ marginTop: 12 }}>
              <label>
                <span>仓库信息栏字号 (px)</span>
                <input
                  type="number"
                  min="8"
                  max="40"
                  step="1"
                  value={config.repoFooterFontSize ?? 14}
                  onChange={(event) => setConfig((c) => ({
                    ...c,
                    repoFooterFontSize: Number(event.target.value) || 14,
                  }))}
                  style={{ width: 80 }}
                />
              </label>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                控制 README 车播每页底部 Stars / Forks / 链接 的字体大小
              </span>
            </div>

            <div className="presentation-hint">
              <strong>清单格式说明</strong>
              <ul>
                <li>每个条目必须提供 `title`、`ttsText`，以及 `url` 或 `htmlPath` 二选一。</li>
                <li>本地 HTML 会被读入固定播放器，并自动补一个 `&lt;base&gt;`，方便相对资源正常加载。</li>
                <li>多网页轮播由固定程序控制，TTS 全部成功缓存后才会进入播放器。</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="presentation-card presentation-card-large">
          <div className="presentation-card-title">播放清单 JSON</div>
          <textarea
            className="presentation-playlist"
            value={config.playlistText}
            onChange={(event) => setConfig((current) => ({
              ...current,
              playlistText: event.target.value,
            }))}
            spellCheck={false}
          />
        </div>

        {(progressLabel || errorMessage || saveMessage) && (
          <div className="presentation-feedback">
            {progressLabel && <div className="presentation-progress">{progressLabel}</div>}
            {saveMessage && <div className="presentation-success">{saveMessage}</div>}
            {errorMessage && <div className="presentation-error">{errorMessage}</div>}
          </div>
        )}
      </div>

      {session && (
        <PresentationPlayerOverlay
          session={session}
          onClose={() => setSession(null)}
        />
      )}
    </>
  );
}

export default PresentationStudio;
