import React, { useState, useEffect, useCallback, useRef } from 'react';
import ConfigPanel from './components/ConfigPanel';
import RepoTable from './components/RepoTable';
import AnalysisView from './components/AnalysisView';
import Auth from './components/Auth';

function App() {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiConfig, setAiConfig] = useState(null);
  const [showConfig, setShowConfig] = useState(true);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(true);
  const [fetchLogs, setFetchLogs] = useState([]);
  const [analyzeLogs, setAnalyzeLogs] = useState([]);
  const [authLogs, setAuthLogs] = useState([]);
  const [configLogs, setConfigLogs] = useState([]);
  const [activeLogTab, setActiveLogTab] = useState('fetch');
  const [authUser, setAuthUser] = useState(null);
  const [selectedRepoName, setSelectedRepoName] = useState(null);
  const [repoTags, setRepoTags] = useState({});

  // Fetch filter state
  const [showFilter, setShowFilter] = useState(false);
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [filterConfig, setFilterConfig] = useState({
    keyword: '',
    maxPages: 1,
    minStars: 5,
    maxStars: '',
    minForks: '',
    maxForks: '',
    startDate: threeDaysAgo,
    endDate: today,
  });

  // Ref to prevent duplicate log listeners (React 19 strict mode mounts twice in dev)
  const logRef = useRef(false);

  useEffect(() => {
    const loadConfig = async () => {
      // Try file-based config first, fallback to localStorage
      try {
        const fileConfig = await window.electronAPI.loadAiConfig();
        if (fileConfig && fileConfig.vendors) {
          setAiConfig({
            vendor: fileConfig.vendor || 'openai',
            vendors: fileConfig.vendors || {},
            systemPrompt: fileConfig.systemPrompt || '',
            ...(fileConfig.vendors?.openai || {}),
          });
          return;
        }
      } catch { /* no file config yet */ }

      // Fallback to localStorage
      const saved = localStorage.getItem('github-scout-ai-configs');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setAiConfig({
            vendor: 'openai',
            vendors: parsed.vendors || {},
            systemPrompt: parsed.systemPrompt || '',
            ...((parsed.vendors || {}).openai || {}),
          });
        } catch { /* ignore */ }
      }
    };
    loadConfig();
  }, []);

  useEffect(() => {
    if (logRef.current) return;
    logRef.current = true;
    window.electronAPI.onLogEntry((entry) => {
      setLogs(prev => [...prev, entry]);
      if (entry.message.startsWith('[GitHub]')) {
        setAuthLogs(prev => [...prev, entry]);
      } else if (entry.message.startsWith('[爬虫]')) {
        setFetchLogs(prev => [...prev, entry]);
      } else if (entry.message.startsWith('[AI]')) {
        setAnalyzeLogs(prev => [...prev, entry]);
      } else if (entry.message.startsWith('[配置]')) {
        setConfigLogs(prev => [...prev, entry]);
      }
    });
  }, []);

  const saveAiConfig = useCallback(async (config) => {
    setAiConfig(config);
    // Persist to local file via IPC
    try {
      await window.electronAPI.saveAiConfig({
        vendor: config.vendor,
        vendors: config.vendors,
        systemPrompt: config.systemPrompt,
      });
    } catch (err) {
      console.error('Failed to save AI config to file:', err);
    }
  }, []);

  const getAvailableAiCandidates = useCallback(() => {
    if (!aiConfig?.vendors) return [];

    return Object.entries(aiConfig.vendors)
      .filter(([, vendorConfig]) => vendorConfig?.baseUrl && vendorConfig?.apiKey)
      .map(([vendor, vendorConfig]) => ({
        vendor,
        baseUrl: vendorConfig.baseUrl,
        apiKey: vendorConfig.apiKey,
        model: vendorConfig.model,
        systemPrompt: aiConfig.systemPrompt,
      }));
  }, [aiConfig]);

  const pickFastestAvailableAi = useCallback(async () => {
    const candidates = getAvailableAiCandidates();
    if (candidates.length === 0) {
      return {
        ok: false,
        message: '请先至少配置一个可用的 AI 提供商',
      };
    }

    const pending = new Set();
    const wrappedPromises = candidates.map((candidate) => {
      const promise = window.electronAPI.testConnection({
        baseUrl: candidate.baseUrl,
        apiKey: candidate.apiKey,
        model: candidate.model,
      })
        .then((result) => ({ candidate, result }))
        .catch((error) => ({
          candidate,
          result: { ok: false, message: error.message || '连接测试失败' },
        }))
        .finally(() => pending.delete(promise));
      pending.add(promise);
      return promise;
    });

    const failures = [];
    while (pending.size > 0) {
      const { candidate, result } = await Promise.race([...pending]);
      if (result.ok) {
        return {
          ok: true,
          candidate,
          testResult: result,
        };
      }
      failures.push(`${candidate.vendor}: ${result.message || '连接失败'}`);
    }

    return {
      ok: false,
      message: failures.join('；') || '没有可用的 AI 提供商',
    };
  }, [getAvailableAiCandidates]);

  const handleExportRepos = () => {
    if (repos.length === 0) return;
    const header = '\uFEFF仓库,语言,Stars,Forks,Issues,创建日期,描述,链接\n';
    const rows = repos.map(r =>
      `"${r.name}","${r.language}","${r.stars}","${r.forks}","${r.open_issues}","${r.created}","${r.description}","${r.url}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `github-scout-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFetchRepos = async () => {
    setLogs([]);
    setFetchLogs([]);
    setLoading(true);
    setRepos([]);
    setAnalysis(null);
    setRepoTags({});
    setActiveLogTab('fetch');
    setShowLogs(true);

    try {
      const result = await window.electronAPI.fetchRepos({ filterConfig });
      setRepos(result.repos || []);
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    if (!aiConfig || repos.length === 0) return;

    setAnalyzeLogs([]);
    setAnalyzing(true);
    setAnalysis(null);
    setActiveLogTab('analyze');
    setShowLogs(true);

    try {
      const selection = await pickFastestAvailableAi();
      if (!selection.ok) {
        setAnalysis({ ok: false, message: `API连接失败: ${selection.message}` });
        setAnalyzing(false);
        return;
      }

      const { candidate, testResult } = selection;
      const config = {
        baseUrl: candidate.baseUrl,
        apiKey: candidate.apiKey,
        model: candidate.model,
        systemPrompt: candidate.systemPrompt,
      };

      setAnalyzeLogs(prev => ([
        ...prev,
        {
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          level: 'info',
          message: `[AI] 已选择最快可用提供商: ${candidate.vendor}${testResult.model ? ` (${testResult.model})` : ''}`,
        },
      ]));

      const result = await window.electronAPI.analyzeRepos({ aiConfig: config, repos });
      setAnalysis(result);
      if (result.repoTags) setRepoTags(result.repoTags);
    } catch (err) {
      setAnalysis({ ok: false, message: err.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRepoClick = (name) => {
    setSelectedRepoName(name);
  };

  const handleTestConnection = async (config) => {
    return window.electronAPI.testConnection(config);
  };

  const clearLogs = () => {
    if (activeLogTab === 'fetch') setFetchLogs([]);
    else if (activeLogTab === 'analyze') setAnalyzeLogs([]);
    else if (activeLogTab === 'auth') setAuthLogs([]);
    else setConfigLogs([]);
  };

  const getCurrentLogs = () => {
    if (activeLogTab === 'fetch') return fetchLogs;
    if (activeLogTab === 'analyze') return analyzeLogs;
    if (activeLogTab === 'auth') return authLogs;
    return configLogs;
  };

  const currentVendor = aiConfig?.vendors?.[aiConfig?.vendor] || aiConfig?.vendors?.custom || {};

  return (
    <div className="app">
      {/* Custom Title Bar */}
      <div className="titlebar" onDoubleClick={() => window.electronAPI.maximize?.()}>
        <div className="titlebar-drag-region">
          <svg className="titlebar-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub Scout
        </div>
        <div className="titlebar-controls">
          <button className="titlebar-btn" title="最小化" onClick={() => window.electronAPI.minimize?.()}>
            <svg width="12" height="12" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="titlebar-btn titlebar-btn-max" title="最大化/还原" onClick={() => window.electronAPI.maximize?.()}>
            <svg width="12" height="12" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button className="titlebar-btn titlebar-btn-close" title="关闭" onClick={() => window.electronAPI.close?.()}>
            <svg width="12" height="12" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
          </button>
        </div>
      </div>

      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">GitHub Scout</h1>
          <span className="app-subtitle">热门仓库爬取 & AI分析</span>
        </div>
        <div className="header-right">
          <Auth onAuthChange={setAuthUser} />
          {repos.length > 0 && (
            <span className="repo-count-badge">
              已爬取 <strong>{repos.length}</strong> 个仓库
            </span>
          )}
          {repos.length > 0 && (
            <button className="export-btn" onClick={handleExportRepos} title="导出为 CSV">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3 13a1 1 0 0 1-1-1v-3a1 1 0 0 1 2 0v3a1 1 0 0 1-1 1zm5-3a1 1 0 0 1-1-1V4a1 1 0 0 1 2 0v5a1 1 0 0 1-1 1zm5 3a1 1 0 0 1-1-1v-3a1 1 0 0 1 2 0v3a1 1 0 0 1-1 1zM1 2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2z"/>
              </svg>
              导出
            </button>
          )}
          <button
            className="filter-btn"
            onClick={() => setShowFilter(!showFilter)}
          >
            筛选 {showFilter ? '▲' : '▼'}
          </button>
          <button
            className={`fetch-btn ${loading ? 'loading' : ''}`}
            onClick={handleFetchRepos}
            disabled={loading || analyzing}
          >
            {loading ? (
              <span><span className="spinner" /> 爬取中...</span>
            ) : (
              <span>一键爬取</span>
            )}
          </button>
          <button
            className="analyze-btn"
            onClick={handleAnalyze}
            disabled={repos.length === 0 || analyzing}
          >
            {analyzing ? 'AI分析中...' : repos.length > 0 ? `AI分析 (${repos.length})` : 'AI分析'}
          </button>
          <button
            className={`log-toggle-btn ${showLogs ? 'active' : ''}`}
            onClick={() => setShowLogs(!showLogs)}
          >
            日志 {logs.length > 0 && <span className="log-badge">{logs.length > 99 ? '99+' : logs.length}</span>}
          </button>
          <button
            className="config-toggle"
            onClick={() => setShowConfig(!showConfig)}
          >
            {showConfig ? '收起' : 'AI配置'}
          </button>
        </div>
      </header>

      {/* Filter Panel */}
      {showFilter && (
        <div className="filter-panel">
          <div className="filter-row">
            <label>
              <span>关键词</span>
              <input
                type="text"
                placeholder="多个关键词用逗号分隔，如：AI, react, ..."
                value={filterConfig.keyword}
                onChange={e => setFilterConfig(prev => ({ ...prev, keyword: e.target.value }))}
              />
            </label>
            <label>
              <span>开始日期</span>
              <input
                type="date"
                value={filterConfig.startDate}
                onChange={e => setFilterConfig(prev => ({ ...prev, startDate: e.target.value }))}
              />
            </label>
            <label>
              <span>结束日期</span>
              <input
                type="date"
                value={filterConfig.endDate}
                max={today}
                onChange={e => setFilterConfig(prev => ({ ...prev, endDate: e.target.value }))}
              />
            </label>
            <label>
              <span>爬取页数</span>
              <input
                type="number"
                min="1"
                max="10"
                value={filterConfig.maxPages}
                onChange={e => setFilterConfig(prev => ({ ...prev, maxPages: parseInt(e.target.value) || 1 }))}
              />
            </label>
          </div>
          <div className="filter-row">
            <label>
              <span>最小 Stars</span>
              <input
                type="number"
                min="0"
                value={filterConfig.minStars}
                onChange={e => setFilterConfig(prev => ({ ...prev, minStars: parseInt(e.target.value) || 0 }))}
              />
            </label>
            <label>
              <span>最大 Stars</span>
              <input
                type="number"
                min="0"
                placeholder="不限"
                value={filterConfig.maxStars}
                onChange={e => setFilterConfig(prev => ({ ...prev, maxStars: e.target.value }))}
              />
            </label>
            <label>
              <span>最小 Forks</span>
              <input
                type="number"
                min="0"
                placeholder="不限"
                value={filterConfig.minForks}
                onChange={e => setFilterConfig(prev => ({ ...prev, minForks: e.target.value }))}
              />
            </label>
            <label>
              <span>最大 Forks</span>
              <input
                type="number"
                min="0"
                placeholder="不限"
                value={filterConfig.maxForks}
                onChange={e => setFilterConfig(prev => ({ ...prev, maxForks: e.target.value }))}
              />
            </label>
            <button
              className="filter-reset"
              onClick={() => setFilterConfig({
                keyword: '',
                maxPages: 1,
                minStars: 5,
                maxStars: '',
                minForks: '',
                maxForks: '',
                startDate: threeDaysAgo,
                endDate: today,
              })}
            >
              重置
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="progress-bar">
          <div className="progress-fill progress-indeterminate" />
        </div>
      )}

      <div className="main-content">
        {showConfig && (
          <ConfigPanel
            aiConfig={aiConfig}
            onSave={saveAiConfig}
            onTest={handleTestConnection}
          />
        )}

        <div className="right-panel">
          <RepoTable repos={repos} repoTags={repoTags} selectedRepoName={selectedRepoName} />

          {showLogs && (logs.length > 0 || loading || analyzing) && (
            <div className="log-section">
              <div className="log-tabs">
                <button
                  className={`log-tab ${activeLogTab === 'fetch' ? 'active' : ''}`}
                  onClick={() => setActiveLogTab('fetch')}
                >
                  爬取日志 {fetchLogs.length > 0 && `(${fetchLogs.length})`}
                </button>
                <button
                  className={`log-tab ${activeLogTab === 'analyze' ? 'active' : ''}`}
                  onClick={() => setActiveLogTab('analyze')}
                >
                  AI分析日志 {analyzeLogs.length > 0 && `(${analyzeLogs.length})`}
                </button>
                <button
                  className={`log-tab ${activeLogTab === 'auth' ? 'active' : ''}`}
                  onClick={() => setActiveLogTab('auth')}
                >
                  登录日志 {authLogs.length > 0 && `(${authLogs.length})`}
                </button>
                <button
                  className={`log-tab ${activeLogTab === 'config' ? 'active' : ''}`}
                  onClick={() => setActiveLogTab('config')}
                >
                  配置 {configLogs.length > 0 && `(${configLogs.length})`}
                </button>
                <button className="log-clear" onClick={clearLogs}>清除</button>
              </div>
              <div className="log-viewport">
                {getCurrentLogs().map((entry, i) => (
                  <div key={i} className={`log-entry log-${entry.level}`}>
                    <span className="log-time">{entry.time}</span>
                    <span className="log-dot" style={{ color: { info: '#58a6ff', success: '#3fb950', error: '#f85149', warn: '#d29922' }[entry.level] }}></span>
                    <span className="log-message">{entry.message}</span>
                  </div>
                ))}
                <div className="log-scroll-anchor" />
              </div>
            </div>
          )}

          {analysis && (
            <AnalysisView analysis={analysis} repoUrlMap={analysis.repoUrlMap || {}} onRepoClick={handleRepoClick} />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
