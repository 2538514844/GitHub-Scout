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

function ConfigPanel({ aiConfig, onSave, onTest, onNavigateSound }) {
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

  useEffect(() => {
    let disposed = false;

    const loadSaved = async () => {
      try {
        const fileConfig = await window.electronAPI.loadAiConfig().catch(() => null);

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
            onClick={() => {
              if (activeVendor !== id) {
                onNavigateSound?.('tab');
              }
              setActiveVendor(id);
            }}
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

        <details
          className="config-details"
          onToggle={() => onNavigateSound?.('toggle')}
        >
          <summary>系统提示词（可选）</summary>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="留空则使用默认分析提示词"
            rows={4}
          />
        </details>

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
      </form>
    </div>
  );
}

export default ConfigPanel;
