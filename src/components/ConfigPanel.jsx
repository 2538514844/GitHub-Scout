import React, { useEffect, useRef, useState } from 'react';

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o' },
  claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn', model: 'Qwen/Qwen2.5-72B-Instruct' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn', model: 'glm-4-plus' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:72b' },
  custom: { baseUrl: '', model: '' },
};

const DEFAULT_PRESENTATION_CONFIG = {
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
  playlistText: '',
};

function ConfigPanel({ aiConfig, onSave, onTest }) {
  const vendorTabsRef = useRef(null);
  const [activeVendor, setActiveVendor] = useState(aiConfig?.vendor || 'openai');
  const [vendors, setVendors] = useState(() => {
    const init = {};
    for (const [id, preset] of Object.entries(PRESETS)) {
      init[id] = {
        baseUrl: preset.baseUrl,
        apiKey: '',
        model: preset.model,
        connected: false,
      };
    }
    return init;
  });
  const [systemPrompt, setSystemPrompt] = useState(aiConfig?.systemPrompt || '');
  const [testResult, setTestResult] = useState(null);
  const [saved, setSaved] = useState(false);

  const [presentationConfig, setPresentationConfig] = useState(DEFAULT_PRESENTATION_CONFIG);
  const [ttsExpanded, setTtsExpanded] = useState(false);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsMessage, setTtsMessage] = useState('');
  const [ttsError, setTtsError] = useState('');
  const [ttsTestResult, setTtsTestResult] = useState(null);

  useEffect(() => {
    let disposed = false;

    const loadSaved = async () => {
      try {
        const [fileConfig, presentationSettings] = await Promise.all([
          window.electronAPI.loadAiConfig().catch(() => null),
          window.electronAPI.loadPresentationConfig().catch(() => null),
        ]);

        if (disposed) return;

        if (fileConfig && fileConfig.vendors) {
          setVendors((prev) => ({ ...prev, ...fileConfig.vendors }));
          if (fileConfig.systemPrompt) {
            setSystemPrompt(fileConfig.systemPrompt);
          }
          if (fileConfig.vendor) {
            setActiveVendor(fileConfig.vendor);
          }
        } else {
          const savedAi = localStorage.getItem('github-scout-ai-configs');
          if (savedAi) {
            try {
              const parsed = JSON.parse(savedAi);
              setVendors((prev) => ({ ...prev, ...(parsed.vendors || {}) }));
              if (parsed.systemPrompt) {
                setSystemPrompt(parsed.systemPrompt);
              }
            } catch {
              // Ignore invalid local fallback.
            }
          }
        }

        if (presentationSettings) {
          setPresentationConfig({
            ...DEFAULT_PRESENTATION_CONFIG,
            ...presentationSettings,
            tts: {
              ...DEFAULT_PRESENTATION_CONFIG.tts,
              ...(presentationSettings.tts || {}),
            },
            player: {
              ...DEFAULT_PRESENTATION_CONFIG.player,
              ...(presentationSettings.player || {}),
            },
          });
        }
      } catch {
        // Keep defaults when loading config fails.
      }
    };

    loadSaved();
    return () => {
      disposed = true;
    };
  }, []);

  const currentVendor = vendors[activeVendor];

  const updateVendor = (key, value) => {
    setVendors((prev) => ({
      ...prev,
      [activeVendor]: { ...prev[activeVendor], [key]: value },
    }));
  };

  const updateTtsField = (key, value) => {
    setPresentationConfig((prev) => ({
      ...prev,
      tts: {
        ...prev.tts,
        [key]: value,
      },
    }));
  };

  const handleSave = async (event) => {
    event.preventDefault();

    if (currentVendor.baseUrl && currentVendor.apiKey) {
      const result = await onTest({
        baseUrl: currentVendor.baseUrl,
        apiKey: currentVendor.apiKey,
        model: currentVendor.model,
      });
      setVendors((prev) => ({
        ...prev,
        [activeVendor]: { ...prev[activeVendor], connected: result.ok },
      }));
      setTestResult(result);
      if (!result.ok) return;
    } else {
      setVendors((prev) => ({
        ...prev,
        [activeVendor]: { ...prev[activeVendor], connected: false },
      }));
    }

    const updatedVendors = {
      ...vendors,
      [activeVendor]: { ...currentVendor, connected: true },
    };

    const nextConfig = {
      vendor: activeVendor,
      vendors: updatedVendors,
      systemPrompt,
      baseUrl: currentVendor.baseUrl,
      apiKey: currentVendor.apiKey,
      model: currentVendor.model,
    };

    onSave(nextConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    if (!currentVendor.baseUrl || !currentVendor.apiKey) return;

    const result = await onTest({
      baseUrl: currentVendor.baseUrl,
      apiKey: currentVendor.apiKey,
      model: currentVendor.model,
    });
    setTestResult(result);

    if (result.ok) {
      setVendors((prev) => ({
        ...prev,
        [activeVendor]: { ...prev[activeVendor], connected: true },
      }));
    }
  };

  const handleSaveTts = async () => {
    setTtsSaving(true);
    setTtsMessage('');
    setTtsError('');

    try {
      await window.electronAPI.savePresentationConfig(presentationConfig);
      setTtsMessage('MiniMax 配置已保存，README 轮播会直接复用这里的设置。');
    } catch (error) {
      setTtsError(error.message || 'MiniMax 配置保存失败');
    } finally {
      setTtsSaving(false);
    }
  };

  const handleTestTts = async () => {
    setTtsTesting(true);
    setTtsError('');
    setTtsMessage('');
    setTtsTestResult(null);

    try {
      const result = await window.electronAPI.testPresentationTts(presentationConfig.tts);
      setTtsTestResult(result);
      if (!result.ok) {
        setTtsError(result.message || 'MiniMax 测试失败');
      }
    } catch (error) {
      setTtsError(error.message || 'MiniMax 测试失败');
    } finally {
      setTtsTesting(false);
    }
  };

  const vendorLabels = {
    openai: 'OpenAI',
    claude: 'Claude',
    siliconflow: '硅基流动',
    deepseek: 'DeepSeek',
    zhipu: '智谱 AI',
    ollama: 'Ollama',
    custom: '自定义厂商',
  };

  return (
    <div className="config-panel">
      <h3>AI 配置</h3>

      <div
        className="vendor-tabs"
        ref={vendorTabsRef}
        onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {Object.keys(vendorLabels).map((id) => (
          <button
            key={id}
            className={`vendor-tab ${activeVendor === id ? 'active' : ''}`}
            onClick={() => setActiveVendor(id)}
          >
            {vendorLabels[id]}
          </button>
        ))}
      </div>

      <form onSubmit={handleSave} className="config-form">
        <label>
          <span>API Base URL</span>
          <input
            type="text"
            value={currentVendor.baseUrl}
            onChange={(event) => updateVendor('baseUrl', event.target.value)}
            placeholder="https://api.xxx.com"
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={currentVendor.apiKey}
            onChange={(event) => updateVendor('apiKey', event.target.value)}
            placeholder="sk-..."
          />
        </label>
        <label>
          <span>Model</span>
          <input
            type="text"
            value={currentVendor.model}
            onChange={(event) => updateVendor('model', event.target.value)}
            placeholder="model-name"
          />
        </label>

        <details className="config-details">
          <summary>系统提示词（可选）</summary>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="留空则使用默认分析提示词"
            rows={4}
          />
        </details>

        <details
          className="config-details"
          onToggle={(event) => setTtsExpanded(event.currentTarget.open)}
        >
          <summary>MiniMax TTS / README 轮播设置</summary>
          <div className="config-subsection">
            <p className="config-hint">
              `爬取描述` 生成 HTML 轮播时，会直接使用这里的 MiniMax 配置生成解说音频。
            </p>
            <label>
              <span>MiniMax API URL</span>
              <input
                type="text"
                value={presentationConfig.tts.apiUrl}
                onChange={(event) => updateTtsField('apiUrl', event.target.value)}
                placeholder="https://api.minimaxi.com/v1/t2a_v2"
              />
            </label>
            <label>
              <span>MiniMax API Key</span>
              <input
                type="password"
                value={presentationConfig.tts.apiKey}
                onChange={(event) => updateTtsField('apiKey', event.target.value)}
                placeholder="Bearer API Key"
              />
            </label>
            <label>
              <span>TTS Model</span>
              <input
                type="text"
                value={presentationConfig.tts.model}
                onChange={(event) => updateTtsField('model', event.target.value)}
                placeholder="speech-2.8-hd"
              />
            </label>
            <label>
              <span>Voice ID</span>
              <input
                type="text"
                value={presentationConfig.tts.voiceId}
                onChange={(event) => updateTtsField('voiceId', event.target.value)}
                placeholder="male-qn-qingse"
              />
            </label>
            <div className="config-inline-grid">
              <label>
                <span>Format</span>
                <input
                  type="text"
                  value={presentationConfig.tts.format}
                  onChange={(event) => updateTtsField('format', event.target.value)}
                  placeholder="mp3"
                />
              </label>
              <label>
                <span>Speed</span>
                <input
                  type="number"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={presentationConfig.tts.speed}
                  onChange={(event) => updateTtsField('speed', event.target.value)}
                />
              </label>
            </div>
            <div className="config-actions">
              <button type="button" className="save-btn" onClick={handleSaveTts} disabled={ttsSaving}>
                {ttsSaving ? '保存中...' : '保存 MiniMax 配置'}
              </button>
              <button type="button" className="test-btn" onClick={handleTestTts} disabled={ttsTesting || !presentationConfig.tts.apiKey}>
                {ttsTesting ? '测试中...' : '测试 TTS 连接'}
              </button>
            </div>
            {ttsMessage && <div className="test-result ok">{ttsMessage}</div>}
            {ttsError && <div className="test-result error">{ttsError}</div>}
            {ttsTestResult?.ok && (
              <div className="test-result ok">
                {`MiniMax 连接成功（模型: ${ttsTestResult.model}，音色: ${ttsTestResult.voiceId}${ttsTestResult.cached ? '，复用缓存' : ''}）`}
              </div>
            )}
          </div>
        </details>

        {!ttsExpanded && (
          <>
            <div className="config-actions">
              <button type="submit" className="save-btn">
                {saved ? '已保存' : '保存 AI 配置'}
              </button>
              <button type="button" className="test-btn" onClick={handleTest} disabled={!currentVendor.baseUrl || !currentVendor.apiKey}>
                测试连接
              </button>
              {currentVendor.connected && (
                <span className="connection-status" title="连接正常">●</span>
              )}
              {!currentVendor.connected && (currentVendor.baseUrl || currentVendor.apiKey) && (
                <span className="connection-status disconnected" title="连接失败或未测试">●</span>
              )}
            </div>
            {testResult && (
              <div className={`test-result ${testResult.ok ? 'ok' : 'error'}`}>
                {testResult.ok ? `连接成功（模型: ${testResult.model}）` : `连接失败: ${testResult.message}`}
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
}

export default ConfigPanel;
