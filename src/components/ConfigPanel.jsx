import React, { useState, useEffect, useCallback, useRef } from 'react';

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o' },
  claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn', model: 'Qwen/Qwen2.5-72B-Instruct' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn', model: 'glm-4-plus' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:72b' },
  custom: { baseUrl: '', model: '' },
};

function ConfigPanel({ aiConfig, onSave, onTest }) {
  const vendorTabsRef = useRef(null);
  const [activeVendor, setActiveVendor] = useState(aiConfig?.vendor || 'openai');
  const [vendors, setVendors] = useState(() => {
    const init = {};
    for (const [id, preset] of Object.entries(PRESETS)) {
      init[id] = { baseUrl: preset.baseUrl, apiKey: '', model: preset.model, connected: false };
    }
    return init;
  });
  const [systemPrompt, setSystemPrompt] = useState(aiConfig?.systemPrompt || '');
  const [testResult, setTestResult] = useState(null);
  const [saved, setSaved] = useState(false);

  // Load saved configs
  useEffect(() => {
    const loadSaved = async () => {
      // Try file first
      try {
        const fileConfig = await window.electronAPI.loadAiConfig();
        if (fileConfig && fileConfig.vendors) {
          setVendors(prev => ({ ...prev, ...fileConfig.vendors }));
          if (fileConfig.systemPrompt) setSystemPrompt(fileConfig.systemPrompt);
          return;
        }
      } catch { /* no file */ }

      // Fallback localStorage
      const saved = localStorage.getItem('github-scout-ai-configs');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setVendors(prev => ({ ...prev, ...parsed.vendors }));
          if (parsed.systemPrompt) setSystemPrompt(parsed.systemPrompt);
        } catch { /* ignore */ }
      }
    };
    loadSaved();
  }, []);

  const currentVendor = vendors[activeVendor];

  const updateVendor = (key, value) => {
    setVendors(prev => ({
      ...prev,
      [activeVendor]: { ...prev[activeVendor], [key]: value },
    }));
  };

  const handleSave = async (e) => {
    e.preventDefault();

    // Test connection first
    if (currentVendor.baseUrl && currentVendor.apiKey) {
      const result = await onTest({
        baseUrl: currentVendor.baseUrl,
        apiKey: currentVendor.apiKey,
        model: currentVendor.model,
      });
      setVendors(prev => ({
        ...prev,
        [activeVendor]: { ...prev[activeVendor], connected: result.ok },
      }));
      setTestResult(result);
      if (!result.ok) return; // Don't save if connection fails
    } else {
      setVendors(prev => ({
        ...prev,
        [activeVendor]: { ...prev[activeVendor], connected: false },
      }));
    }

    // Save via parent (handles both localStorage and file save)
    const updatedVendors = { ...vendors };
    updatedVendors[activeVendor] = { ...currentVendor, connected: true };

    const config = {
      vendor: activeVendor,
      vendors: updatedVendors,
      systemPrompt,
      baseUrl: currentVendor.baseUrl,
      apiKey: currentVendor.apiKey,
      model: currentVendor.model,
    };
    onSave(config);
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
      setVendors(prev => ({
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
    zhipu: '智谱AI',
    ollama: 'Ollama',
    custom: '自定义厂商',
  };

  return (
    <div className="config-panel">
      <h3>AI 配置</h3>

      <div className="vendor-tabs" ref={vendorTabsRef} onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}>
        {Object.keys(vendorLabels).map(id => (
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
            onChange={e => updateVendor('baseUrl', e.target.value)}
            placeholder="https://api.xxx.com"
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={currentVendor.apiKey}
            onChange={e => updateVendor('apiKey', e.target.value)}
            placeholder="sk-..."
          />
        </label>
        <label>
          <span>Model</span>
          <input
            type="text"
            value={currentVendor.model}
            onChange={e => updateVendor('model', e.target.value)}
            placeholder="model-name"
          />
        </label>

        <details className="config-details">
          <summary>系统提示词 (可选)</summary>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="留空使用默认分析提示词"
            rows={4}
          />
        </details>

        <div className="config-actions">
          <button type="submit" className="save-btn">
            {saved ? '✓ 已保存' : '保存配置'}
          </button>
          <button type="button" className="test-btn" onClick={handleTest} disabled={!currentVendor.baseUrl || !currentVendor.apiKey}>
            测试连接
          </button>
          {currentVendor.connected && (
            <span className="connection-status" title="连接正常">✓</span>
          )}
          {!currentVendor.connected && (currentVendor.baseUrl || currentVendor.apiKey) && (
            <span className="connection-status disconnected" title="连接失败或未测试">✗</span>
          )}
        </div>
        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'error'}`}>
            {testResult.ok ? `成功! (模型: ${testResult.model})` : `失败: ${testResult.message}`}
          </div>
        )}
      </form>
    </div>
  );
}

export default ConfigPanel;
