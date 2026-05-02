import React, { useState, useEffect, useCallback } from 'react';

export default function PromptEditorPanel() {
  const [prompts, setPrompts] = useState([]);
  const [values, setValues] = useState({});
  const [selectedKey, setSelectedKey] = useState(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusMessage, setStatusMessage] = useState(null);

  // History state
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(null);
  const [rollbackMsg, setRollbackMsg] = useState(null);

  useEffect(() => {
    window.electronAPI.loadAllPrompts().then((result) => {
      setPrompts(result.prompts || []);
      setValues(result.values || {});
    }).catch((err) => {
      setStatusMessage({ type: 'error', text: '加载失败: ' + err.message });
    });
  }, []);

  useEffect(() => {
    if (selectedKey && values[selectedKey]) {
      setEditText(values[selectedKey].currentText);
      setShowHistory(false);
      setPreviewVersion(null);
      setRollbackMsg(null);
    }
  }, [selectedKey, values]);

  const handleSave = useCallback(async () => {
    if (!selectedKey) return;
    setSaving(true);
    try {
      const result = await window.electronAPI.savePrompt(selectedKey, editText);
      if (result.ok) {
        setValues((prev) => ({
          ...prev,
          [selectedKey]: {
            ...prev[selectedKey],
            currentText: editText,
            isCustomized: editText !== prev[selectedKey].defaultText,
          },
        }));
        setStatusMessage({ type: 'success', text: '已保存' });
        setPreviewVersion(null);
      } else {
        setStatusMessage({ type: 'error', text: result.message || '保存失败' });
      }
    } catch (err) {
      setStatusMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMessage(null), 2500);
    }
  }, [selectedKey, editText]);

  const handleReset = useCallback(async () => {
    if (!selectedKey) return;
    await window.electronAPI.resetPrompt(selectedKey);
    const defaultText = values[selectedKey].defaultText;
    setEditText(defaultText);
    setValues((prev) => ({
      ...prev,
      [selectedKey]: {
        ...prev[selectedKey],
        currentText: defaultText,
        isCustomized: false,
      },
    }));
    setShowHistory(false);
    setPreviewVersion(null);
    setStatusMessage({ type: 'success', text: '已重置为默认' });
    setTimeout(() => setStatusMessage(null), 2500);
  }, [selectedKey, values]);

  const handleLoadHistory = useCallback(async () => {
    if (!selectedKey) return;
    setLoadingHistory(true);
    setPreviewVersion(null);
    setRollbackMsg(null);
    try {
      const result = await window.electronAPI.getPromptHistory(selectedKey);
      setHistoryEntries(result.history || []);
      setShowHistory(true);
    } catch (err) {
      setRollbackMsg({ type: 'error', text: '加载历史失败: ' + err.message });
    } finally {
      setLoadingHistory(false);
    }
  }, [selectedKey]);

  const handleViewVersion = useCallback((entry) => {
    setPreviewVersion(entry);
  }, []);

  const handleRollback = useCallback(async (entry) => {
    if (!selectedKey) return;
    try {
      const result = await window.electronAPI.rollbackPrompt(selectedKey, entry.index);
      if (result.ok) {
        setEditText(result.text);
        setValues((prev) => ({
          ...prev,
          [selectedKey]: {
            ...prev[selectedKey],
            currentText: result.text,
            isCustomized: result.text !== prev[selectedKey].defaultText,
          },
        }));
        setRollbackMsg({ type: 'success', text: `已回退到版本 ${entry.version}` });
        setPreviewVersion(null);
        // Refresh history
        const histResult = await window.electronAPI.getPromptHistory(selectedKey);
        setHistoryEntries(histResult.history || []);
      } else {
        setRollbackMsg({ type: 'error', text: result.message || '回退失败' });
      }
    } catch (err) {
      setRollbackMsg({ type: 'error', text: err.message });
    }
    setTimeout(() => setRollbackMsg(null), 3000);
  }, [selectedKey, values]);

  const filtered = prompts.filter((p) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      p.name.toLowerCase().includes(term) ||
      p.key.toLowerCase().includes(term) ||
      p.category.toLowerCase().includes(term)
    );
  });

  const grouped = {};
  for (const p of filtered) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  const selectedValue = selectedKey ? values[selectedKey] : null;

  const formatTimestamp = (ts) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch {
      return ts;
    }
  };

  const truncatedPreview = (text, maxLen = 80) => {
    const t = String(text || '').replace(/\n/g, ' ');
    return t.length > maxLen ? t.slice(0, maxLen) + '...' : t;
  };

  return (
    <div className="prompt-editor-panel">
      <div className="prompt-editor-header">
        <h3>提示词编辑器</h3>

      </div>

      <input
        className="prompt-search"
        type="text"
        placeholder="搜索提示词..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />

      <div className="prompt-list">
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category} className="prompt-category-group">
            <div className="prompt-category-label">{category}</div>
            {items.map((p) => (
              <div
                key={p.key}
                className={`prompt-list-item ${selectedKey === p.key ? 'active' : ''}`}
                onClick={() => setSelectedKey(p.key)}
              >
                <span className="prompt-name">{p.name}</span>
                <span className="prompt-item-badges">
                  {p.isTemplate && <span className="prompt-badge template">模板</span>}
                  {values[p.key]?.isCustomized && (
                    <span className="prompt-badge customized">已自定义</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="prompt-list-empty">无匹配的提示词</div>
        )}
      </div>

      {selectedKey && selectedValue && (
        <div className="prompt-editor-area">
          <div className="prompt-editor-toolbar">
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {selectedValue.isCustomized && (
              <button className="reset-btn" onClick={handleReset}>
                重置为默认
              </button>
            )}
            <button
              className="history-btn"
              onClick={handleLoadHistory}
              disabled={loadingHistory}
            >
              {loadingHistory ? '加载中...' : '历史'}
            </button>
            {statusMessage && (
              <span className={`prompt-status ${statusMessage.type}`}>
                {statusMessage.text}
              </span>
            )}
          </div>

          {rollbackMsg && (
            <div className={`prompt-rollback-msg ${rollbackMsg.type}`}>
              {rollbackMsg.text}
            </div>
          )}

          {showHistory && (
            <div className="prompt-history-panel">
              <div className="prompt-history-header">
                <span>版本历史 ({historyEntries.length})</span>
                <button
                  className="prompt-history-close"
                  onClick={() => { setShowHistory(false); setPreviewVersion(null); }}
                >
                  ✕
                </button>
              </div>
              {historyEntries.length === 0 ? (
                <div className="prompt-history-empty">暂无历史版本</div>
              ) : (
                <div className="prompt-history-list">
                  {[...historyEntries].reverse().map((entry) => (
                    <div
                      key={entry.index}
                      className={`prompt-history-item ${previewVersion?.index === entry.index ? 'selected' : ''}`}
                      onClick={() => handleViewVersion(entry)}
                    >
                      <span className="prompt-history-version">v{entry.version}</span>
                      <span className="prompt-history-time">{formatTimestamp(entry.timestamp)}</span>
                      <span className="prompt-history-preview">{truncatedPreview(entry.text)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {previewVersion && (
            <div className="prompt-history-preview-panel">
              <div className="prompt-history-preview-header">
                <span>预览 v{previewVersion.version} — {formatTimestamp(previewVersion.timestamp)}</span>
                <button
                  className="save-btn"
                  onClick={() => handleRollback(previewVersion)}
                >
                  回退到此版本
                </button>
              </div>
              <textarea
                className="prompt-textarea prompt-history-preview-textarea"
                value={previewVersion.text}
                readOnly
                spellCheck={false}
              />
            </div>
          )}

          {!showHistory && !previewVersion && (
            <>
              <div className="prompt-editor-meta">
                <span className="prompt-editor-key">{selectedKey}</span>
                {selectedValue.isTemplate && (
                  <span className="prompt-badge template">模板提示词</span>
                )}
              </div>
              <textarea
                className="prompt-textarea"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                spellCheck={false}
              />
              {selectedValue.isTemplate && selectedValue.templateVars?.length > 0 && (
                <div className="prompt-template-vars">
                  <span>模板变量：</span>
                  {selectedValue.templateVars.map((v) => (
                    <code key={v}>{'${' + v + '}'}</code>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {!selectedKey && (
        <div className="prompt-editor-placeholder">
          从左侧列表中选择一个提示词进行编辑
        </div>
      )}
    </div>
  );
}
