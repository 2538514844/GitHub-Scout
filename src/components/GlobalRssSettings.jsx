import { useState, useCallback } from 'react';

export default function GlobalRssSettings({ rss, onSave }) {
  const [draft, setDraft] = useState(() => ({
    enabled: rss?.enabled !== false,
    repo: rss?.repo || '',
    branch: rss?.branch || 'main',
    filePath: rss?.filePath || 'feed.xml',
    fileMode: rss?.fileMode || 'dated',
    commitMessage: rss?.commitMessage || 'Update RSS feed',
    title: rss?.title || '',
    description: rss?.description || '',
    link: rss?.link || '',
    publicUrl: rss?.publicUrl || '',
    maxItems: rss?.maxItems || 200,
  }));
  const [savedFlag, setSavedFlag] = useState(null);

  const updateDraft = useCallback((key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    await onSave(draft);
    setSavedFlag(Date.now());
    setTimeout(() => setSavedFlag(null), 1500);
  }, [draft, onSave]);

  const inputStyle = {
    padding: 6, border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)', fontSize: 12, width: '100%',
  };

  const labelStyle = {
    display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0',
    fontSize: 11, color: 'var(--text-secondary)',
  };

  return (
    <div className="smtp-settings-panel">
      <div className="email-push-header">RSS 全局设置</div>
      <div className="email-push-form">
        <div style={{
          padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)',
          background: 'rgba(230, 126, 34, 0.08)', borderRadius: 6, marginBottom: 10,
          border: '1px solid rgba(230, 126, 34, 0.15)', lineHeight: 1.5,
        }}>
          全局 RSS 推送：配置后可在任意仓库列表中使用"上传全局 RSS"将仓库推送到 RSS 订阅地址。
          {draft.fileMode === 'dated' && (
            <span style={{ display: 'block', marginTop: 4, color: 'var(--accent-orange)' }}>
              按日期模式：每次上传创建独立文件，不会覆盖往期内容。首页自动生成目录。
            </span>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => updateDraft('enabled', e.target.checked)}
          />
          <span style={{ fontWeight: 600, color: 'var(--accent-orange)' }}>启用全局 RSS 输出</span>
        </label>

        {draft.enabled && (
          <>
            <label style={labelStyle}>
              <span>目标仓库</span>
              <input type="text" value={draft.repo} onChange={(e) => updateDraft('repo', e.target.value)}
                placeholder="username/repo" style={inputStyle} />
            </label>

            <div style={{ padding: '6px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
              <span style={{ display: 'block', marginBottom: 4 }}>文件模式</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 16, cursor: 'pointer' }}>
                <input type="radio" name="fileMode" checked={draft.fileMode === 'dated'} onChange={() => updateDraft('fileMode', 'dated')} />
                按日期分文件
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="radio" name="fileMode" checked={draft.fileMode === 'merge'} onChange={() => updateDraft('fileMode', 'merge')} />
                合并到同一文件
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: draft.fileMode === 'dated' ? '1fr 1fr' : '1fr 1fr 1fr', gap: 8 }}>
              <label style={labelStyle}>
                <span>分支</span>
                <input type="text" value={draft.branch} onChange={(e) => updateDraft('branch', e.target.value)}
                  placeholder="main" style={inputStyle} />
              </label>
              <label style={labelStyle}>
                <span>{draft.fileMode === 'dated' ? '文件路径模板' : '文件路径'}</span>
                <input type="text" value={draft.filePath} onChange={(e) => updateDraft('filePath', e.target.value)}
                  placeholder={draft.fileMode === 'dated' ? 'feeds/feed-{date}.xml' : 'feed.xml'} style={inputStyle} />
                {draft.fileMode === 'dated' && (
                  <span style={{ fontSize: 10, color: 'var(--accent-orange)' }}>{`{date}`} → 上传当天日期 YYYY-MM-DD</span>
                )}
              </label>
              {draft.fileMode === 'merge' && (
                <label style={labelStyle}>
                  <span>保留条数</span>
                  <input type="number" value={draft.maxItems || 200} onChange={(e) => updateDraft('maxItems', parseInt(e.target.value) || 200)}
                    placeholder="200" min={1} max={1000} style={inputStyle} />
                </label>
              )}
            </div>

            <label style={labelStyle}>
              <span>Commit 信息</span>
              <input type="text" value={draft.commitMessage} onChange={(e) => updateDraft('commitMessage', e.target.value)}
                placeholder="Update RSS feed" style={inputStyle} />
            </label>

            <label style={labelStyle}>
              <span>订阅标题</span>
              <input type="text" value={draft.title} onChange={(e) => updateDraft('title', e.target.value)}
                placeholder="GitHub Scout 仓库推送" style={inputStyle} />
            </label>

            <label style={labelStyle}>
              <span>订阅描述</span>
              <input type="text" value={draft.description} onChange={(e) => updateDraft('description', e.target.value)}
                placeholder="GitHub 热门仓库推送" style={inputStyle} />
            </label>

            <label style={labelStyle}>
              <span>订阅链接（RSS 中显示的网站链接）</span>
              <input type="text" value={draft.link} onChange={(e) => updateDraft('link', e.target.value)}
                placeholder="https://github.com" style={inputStyle} />
            </label>

            <label style={labelStyle}>
              <span>{draft.fileMode === 'dated' ? '发布首页（留空自动生成 index.html）' : '自定义公开 URL（留空自动生成）'}</span>
              <input type="text" value={draft.publicUrl} onChange={(e) => updateDraft('publicUrl', e.target.value)}
                placeholder={draft.fileMode === 'dated'
                  ? '首页地址：https://xxx.github.io/'
                  : `自动：https://${(draft.repo || 'owner/repo').split('/')[1] || 'repo'}/${draft.filePath || 'feed.xml'}`}
                style={inputStyle} />
            </label>
          </>
        )}

        <div className="email-push-actions">
          <button className="push-btn push-btn-save" onClick={handleSave}>
            {savedFlag ? '✓ 已保存' : '保存 RSS 设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
