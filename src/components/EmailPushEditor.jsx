import { useState, useCallback, useMemo } from 'react';

export default function EmailPushEditor({ account, repos = [], onClose, onSend, sending, onUploadRss, uploadingRss, onUploadGlobalRss, uploadingGlobalRss, globalRss }) {
  const [editableRepos, setEditableRepos] = useState(() =>
    repos.map((r) => ({ ...r, checked: true })),
  );
  const [editingIndex, setEditingIndex] = useState(null);
  const [editBuffer, setEditBuffer] = useState({});
  const [sendResults, setSendResults] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [rssResult, setRssResult] = useState(null);
  const [globalRssResult, setGlobalRssResult] = useState(null);

  const checkedCount = useMemo(
    () => editableRepos.filter((r) => r.checked).length,
    [editableRepos],
  );

  const allChecked = useMemo(
    () => editableRepos.length > 0 && editableRepos.every((r) => r.checked),
    [editableRepos],
  );

  const toggleRepo = useCallback((index) => {
    setEditableRepos((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], checked: !next[index].checked };
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setEditableRepos((prev) => {
      const target = !prev.every((r) => r.checked);
      return prev.map((r) => ({ ...r, checked: target }));
    });
  }, []);

  const startEdit = useCallback((index) => {
    setEditingIndex(index);
    const r = editableRepos[index];
    setEditBuffer({
      name: r.name,
      description: r.aiDescription || r.description || '',
      tags: (r.aiTags || []).join(', '),
      stars: r.stars,
      forks: r.forks,
    });
  }, [editableRepos]);

  const saveEdit = useCallback(() => {
    if (editingIndex === null) return;
    setEditableRepos((prev) => {
      const next = [...prev];
      next[editingIndex] = {
        ...next[editingIndex],
        name: editBuffer.name,
        aiDescription: editBuffer.description,
        aiTags: editBuffer.tags ? editBuffer.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        stars: editBuffer.stars,
        forks: editBuffer.forks,
      };
      return next;
    });
    setEditingIndex(null);
  }, [editingIndex, editBuffer]);

  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditBuffer({});
  }, []);

  const updateEditField = useCallback(
    (field, value) => {
      setEditBuffer((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const selected = editableRepos.filter((r) => r.checked);
    if (selected.length === 0) {
      setSendError('请至少勾选一个仓库');
      return;
    }
    setSendError(null);
    setSendResults(null);
    try {
      const result = await onSend(account.id, selected);
      setSendResults(result.results || []);
      if (!result.ok && result.results) {
        const failed = result.results.filter((r) => !r.ok);
        if (failed.length > 0) {
          setSendError(`部分发送失败: ${failed.map((f) => f.recipient).join(', ')}`);
        }
      }
    } catch (e) {
      setSendError(e.message);
    }
  }, [editableRepos, account, onSend]);

  const handleUploadRss = useCallback(async () => {
    const selected = editableRepos.filter((r) => r.checked);
    if (selected.length === 0) {
      setRssResult({ ok: false, message: '请至少勾选一个仓库' });
      return;
    }
    setRssResult(null);
    try {
      const result = await onUploadRss(account.id, selected);
      setRssResult(result);
    } catch (e) {
      setRssResult({ ok: false, message: e.message });
    }
  }, [editableRepos, account, onUploadRss]);

  const handleUploadGlobalRss = useCallback(async () => {
    const selected = editableRepos.filter((r) => r.checked);
    if (selected.length === 0) {
      setGlobalRssResult({ ok: false, message: '请至少勾选一个仓库' });
      return;
    }
    setGlobalRssResult(null);
    try {
      const result = await onUploadGlobalRss(selected);
      setGlobalRssResult(result);
    } catch (e) {
      setGlobalRssResult({ ok: false, message: e.message });
    }
  }, [editableRepos, onUploadGlobalRss]);

  return (
    <div className="email-push-editor-overlay">
      <div className="email-push-editor">
        {/* Header */}
        <div className="email-push-editor-header">
          <div className="email-push-editor-title">
            <h3>{account.name} - 仓库推送</h3>
            <span className="email-push-editor-count">
              共 {editableRepos.length} 个仓库，已选 {checkedCount} 个
            </span>
          </div>
          <div className="email-push-editor-toolbar">
            <button className="push-btn push-btn-sm" onClick={toggleAll}>
              {allChecked ? '取消全选' : '全选'}
            </button>
            <button className="push-btn push-btn-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        {/* Repo Table */}
        <div className="email-push-editor-table-wrap">
          <table className="email-push-editor-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>仓库 / 标签</th>
                <th style={{ width: 70 }}>语言</th>
                <th style={{ width: 60 }}>Stars</th>
                <th style={{ width: 60 }}>Forks</th>
                <th style={{ width: 90 }}>创建</th>
                <th>AI 描述</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {editableRepos.map((repo, idx) => (
                <tr
                  key={repo.name + idx}
                  className={`${repo.checked ? '' : 'unchecked'}${editingIndex === idx ? ' editing' : ''}`}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={repo.checked}
                      onChange={() => toggleRepo(idx)}
                    />
                  </td>
                  {editingIndex === idx ? (
                    <>
                      <td>
                        <input
                          type="text"
                          value={editBuffer.name}
                          onChange={(e) => updateEditField('name', e.target.value)}
                          className="push-edit-input"
                        />
                        <input
                          type="text"
                          value={editBuffer.tags || ''}
                          onChange={(e) => updateEditField('tags', e.target.value)}
                          className="push-edit-input"
                          style={{ marginTop: 3, fontSize: 11 }}
                          placeholder="标签，逗号分隔"
                        />
                      </td>
                      <td>{repo.language || 'N/A'}</td>
                      <td>
                        <input
                          type="number"
                          value={editBuffer.stars}
                          onChange={(e) => updateEditField('stars', parseInt(e.target.value, 10) || 0)}
                          className="push-edit-input push-edit-num"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={editBuffer.forks}
                          onChange={(e) => updateEditField('forks', parseInt(e.target.value, 10) || 0)}
                          className="push-edit-input push-edit-num"
                        />
                      </td>
                      <td>{repo.created}</td>
                      <td>
                        <input
                          type="text"
                          value={editBuffer.description}
                          onChange={(e) => updateEditField('description', e.target.value)}
                          className="push-edit-input"
                        />
                      </td>
                      <td>
                        <div className="push-edit-actions">
                          <button className="push-btn push-btn-sm" onClick={saveEdit}>
                            保存
                          </button>
                          <button className="push-btn push-btn-sm push-btn-close" onClick={cancelEdit}>
                            取消
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="repo-name">
                        <a
                          href={repo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {repo.name}
                        </a>
                        {(repo.aiTags && repo.aiTags.length > 0) && (
                          <div className="push-tags-row">
                            {repo.aiTags.map((tag, ti) => (
                              <span key={ti} className="push-tag-badge">{tag}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{repo.language || 'N/A'}</td>
                      <td>⭐ {repo.stars}</td>
                      <td>🍴 {repo.forks}</td>
                      <td>{repo.created}</td>
                      <td className="repo-desc">{repo.aiDescription || repo.description}</td>
                      <td>
                        <button className="push-btn push-btn-sm" onClick={() => startEdit(idx)}>
                          编辑
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="email-push-editor-footer">
          <div className="email-push-editor-status">
            {sendError && <span className="push-test-msg fail">{sendError}</span>}
            {sendResults && !sendError && (
              <div className="push-send-results">
                {sendResults.map((r, i) => (
                  <span key={i} className={`push-test-msg ${r.ok ? 'ok' : 'fail'}`}>
                    {r.ok ? `✓ ${r.recipient} 已发送` : `✗ ${r.recipient}: ${r.error}`}
                  </span>
                ))}
              </div>
            )}
            {rssResult && (
              <div className="push-send-results">
                <span className={`push-test-msg ${rssResult.ok ? 'ok' : 'fail'}`}>
                  {rssResult.ok
                    ? <>✓ RSS 已上传{rssResult.publicUrl && <> — <a href={rssResult.publicUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{rssResult.publicUrl}</a></>}</>
                    : `✗ ${rssResult.message}`}
                </span>
              </div>
            )}
            {globalRssResult && (
              <div className="push-send-results">
                <span className={`push-test-msg ${globalRssResult.ok ? 'ok' : 'fail'}`}>
                  {globalRssResult.ok
                    ? <>✓ 全局 RSS 已上传{globalRssResult.publicUrl && <> — <a href={globalRssResult.publicUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{globalRssResult.publicUrl}</a></>}</>
                    : `✗ ${globalRssResult.message}`}
                </span>
              </div>
            )}
          </div>
          <div className="email-push-editor-buttons">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginRight: 12 }}>
              收件人: {(account.recipients || []).join(', ')}
            </span>
            {account.rssConfig?.enabled && (
              <button
                className="push-btn push-btn-rss"
                onClick={handleUploadRss}
                disabled={uploadingRss || checkedCount === 0}
              >
                {uploadingRss ? '上传中...' : `本账户 RSS (${checkedCount})`}
              </button>
            )}
            {globalRss?.enabled && onUploadGlobalRss && (
              <button
                className="push-btn push-btn-rss"
                onClick={handleUploadGlobalRss}
                disabled={uploadingGlobalRss || checkedCount === 0}
                style={{ background: '#e67e22', borderColor: '#e67e22' }}
              >
                {uploadingGlobalRss ? '上传中...' : `全局 RSS (${checkedCount})`}
              </button>
            )}
            <button
              className="push-btn push-btn-send"
              onClick={handleSend}
              disabled={sending || checkedCount === 0}
            >
              {sending ? '发送中...' : `发送邮件 (${checkedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
