import { useState, useCallback, useEffect } from 'react';

const DEFAULT_CRAWL_CONFIG = {
  keyword: '',
  maxPages: 1,
  minStars: 5,
  maxStars: '',
  minForks: '',
  maxForks: '',
  startDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  endDate: new Date().toISOString().split('T')[0],
};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function newAccount() {
  return {
    id: generateId(),
    name: '',
    crawlConfig: { ...DEFAULT_CRAWL_CONFIG },
    recipients: [],
    rssConfig: {
      enabled: false,
      title: '',
      description: '',
      link: '',
      repo: '',
      branch: 'main',
      filePath: 'feed.xml',
      commitMessage: 'Update RSS feed',
      publicUrl: '',
    },
  };
}

export default function EmailPushPanel({
  accounts = [],
  onUpdateAccounts,
  onCrawlAccount,
  onOpenEditor,
  crawlingAccountId,
  loading,
  globalSmtp,
  onOpenSmtpSettings,
  globalRss,
  onOpenRssSettings,
}) {
  const [activeId, setActiveId] = useState(() => (accounts.length > 0 ? accounts[0].id : null));
  const [editDraft, setEditDraft] = useState(null);
  const [recipientInput, setRecipientInput] = useState('');
  const [savedFlag, setSavedFlag] = useState(null);

  const activeAccount = accounts.find((a) => a.id === activeId) || null;

  useEffect(() => {
    if (activeAccount) {
      setEditDraft(JSON.parse(JSON.stringify(activeAccount)));
    } else {
      setEditDraft(null);
    }
  }, [activeId, accounts]);

  const updateDraft = useCallback(
    (key, value) => {
      setEditDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    [],
  );

  const updateCrawl = useCallback(
    (key, value) => {
      setEditDraft((prev) => {
        if (!prev) return prev;
        return { ...prev, crawlConfig: { ...prev.crawlConfig, [key]: value } };
      });
    },
    [],
  );

  const handleSelectAccount = useCallback((id) => {
    setActiveId(id);
  }, []);

  const handleAddAccount = useCallback(() => {
    const account = newAccount();
    const next = [...accounts, account];
    onUpdateAccounts(next);
    setActiveId(account.id);
  }, [accounts, onUpdateAccounts]);

  const handleDeleteAccount = useCallback(
    (id) => {
      const next = accounts.filter((a) => a.id !== id);
      onUpdateAccounts(next);
      if (activeId === id) {
        setActiveId(next.length > 0 ? next[0].id : null);
      }
    },
    [accounts, activeId, onUpdateAccounts],
  );

  const handleSave = useCallback(() => {
    if (!editDraft) return;
    const next = accounts.map((a) => (a.id === editDraft.id ? editDraft : a));
    onUpdateAccounts(next);
    setSavedFlag(Date.now());
    setTimeout(() => setSavedFlag(null), 1500);
  }, [editDraft, accounts, onUpdateAccounts]);

  const handleCrawl = useCallback(() => {
    if (!activeAccount) return;
    onCrawlAccount(activeAccount.id);
    onOpenEditor(activeAccount.id, []);
  }, [activeAccount, onCrawlAccount, onOpenEditor]);

  const addRecipient = useCallback(() => {
    const email = recipientInput.trim();
    if (!email || !email.includes('@')) return;
    const current = editDraft?.recipients || [];
    if (current.includes(email)) return;
    updateDraft(
      'recipients',
      [...current, email],
    );
    setRecipientInput('');
  }, [recipientInput, editDraft, updateDraft]);

  const removeRecipient = useCallback(
    (email) => {
      const current = editDraft?.recipients || [];
      updateDraft(
        'recipients',
        current.filter((r) => r !== email),
      );
    },
    [editDraft, updateDraft],
  );

  const handleRecipientKey = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRecipient();
      }
    },
    [addRecipient],
  );

  if (!activeAccount && accounts.length === 0) {
    return (
      <div className="email-push-panel">
        <div className="email-push-header">个人推送</div>
        <div className="email-push-empty">
          <p>暂无邮箱账户</p>
          <button className="fetch-btn" onClick={handleAddAccount}>
            + 添加邮箱
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="email-push-panel">
      <div className="email-push-header">个人推送</div>

      {/* Account Tabs */}
      <div className="email-push-tabs">
        {accounts.map((a) => (
          <div
            key={a.id}
            className={`email-push-tab${a.id === activeId ? ' active' : ''}`}
            onClick={() => handleSelectAccount(a.id)}
          >
            <span className="email-push-tab-name">{a.name || '未命名'}</span>
            <button
              className="email-push-tab-del"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAccount(a.id);
              }}
              title="删除"
            >
              ×
            </button>
          </div>
        ))}
        <button className="email-push-tab-add" onClick={handleAddAccount} title="添加邮箱">
          +
        </button>
      </div>

      {/* Account Editor */}
      {editDraft && (
        <div className="email-push-form">
          {/* Account Name */}
          <details className="email-push-section" open>
            <summary>账户名称</summary>
            <label>
              <span>发件名称</span>
              <input
                type="text"
                value={editDraft.name}
                onChange={(e) => updateDraft('name', e.target.value)}
                placeholder="如：我的 Gmail"
              />
            </label>
          </details>

          {/* Global SMTP Indicator */}
          <div style={{
            padding: '8px 12px', marginBottom: 8, borderRadius: 6,
            background: 'rgba(88, 166, 255, 0.06)', border: '1px solid rgba(88, 166, 255, 0.12)',
            fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}><span className="material-icons" style={{ fontSize: 14, verticalAlign: 'text-bottom' }}>mail</span> SMTP 全局设置</span>
              <button
                className="push-btn push-btn-sm"
                onClick={onOpenSmtpSettings}
                style={{ fontSize: 10 }}
              >
                配置
              </button>
            </div>
            <div style={{ marginTop: 4 }}>
              {globalSmtp?.host ? (
                <>
                  <div>服务器: {globalSmtp.host}:{globalSmtp.port}</div>
                  <div>用户: {globalSmtp.user || '(未设置)'}</div>
                </>
              ) : (
                <span style={{ color: 'var(--accent-orange)' }}>! 尚未配置 SMTP</span>
              )}
            </div>
          </div>

          {/* Crawl Settings */}
          <details className="email-push-section">
            <summary>爬取设置</summary>
            <label>
              <span>关键词</span>
              <input
                type="text"
                value={editDraft.crawlConfig.keyword}
                onChange={(e) => updateCrawl('keyword', e.target.value)}
                placeholder="AI, LLM, agent"
              />
            </label>
            <div className="config-inline-grid">
              <label>
                <span>最低 Stars</span>
                <input
                  type="number"
                  value={editDraft.crawlConfig.minStars}
                  onChange={(e) => updateCrawl('minStars', parseInt(e.target.value, 10) || 0)}
                />
              </label>
              <label>
                <span>最高 Stars（留空不限）</span>
                <input
                  type="text"
                  value={editDraft.crawlConfig.maxStars}
                  onChange={(e) => updateCrawl('maxStars', e.target.value)}
                />
              </label>
              <label>
                <span>最低 Forks</span>
                <input
                  type="text"
                  value={editDraft.crawlConfig.minForks}
                  onChange={(e) => updateCrawl('minForks', e.target.value)}
                />
              </label>
              <label>
                <span>最高 Forks</span>
                <input
                  type="text"
                  value={editDraft.crawlConfig.maxForks}
                  onChange={(e) => updateCrawl('maxForks', e.target.value)}
                />
              </label>
              <label>
                <span>开始日期</span>
                <input
                  type="date"
                  value={editDraft.crawlConfig.startDate}
                  onChange={(e) => updateCrawl('startDate', e.target.value)}
                />
              </label>
              <label>
                <span>结束日期</span>
                <input
                  type="date"
                  value={editDraft.crawlConfig.endDate}
                  onChange={(e) => updateCrawl('endDate', e.target.value)}
                />
              </label>
              <label>
                <span>爬取页数</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={editDraft.crawlConfig.maxPages}
                  onChange={(e) => updateCrawl('maxPages', parseInt(e.target.value, 10) || 1)}
                />
              </label>
            </div>
          </details>

          {/* Recipients */}
          <details className="email-push-section" open>
            <summary>收件人</summary>
            <div className="email-push-recipients">
              {(editDraft.recipients || []).map((email) => (
                <span key={email} className="recipient-tag">
                  {email}
                  <button onClick={() => removeRecipient(email)}>×</button>
                </span>
              ))}
            </div>
            <div className="email-push-recipient-input">
              <input
                type="email"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                onKeyDown={handleRecipientKey}
                placeholder="输入邮箱后按回车添加"
              />
              <button onClick={addRecipient}>添加</button>
            </div>
          </details>

          {/* Global RSS Indicator */}
          <div style={{
            padding: '8px 12px', marginBottom: 8, borderRadius: 6,
            background: 'rgba(230, 126, 34, 0.06)', border: '1px solid rgba(230, 126, 34, 0.12)',
            fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--accent-orange)' }}><span className="material-icons" style={{ fontSize: 14, verticalAlign: 'text-bottom' }}>rss_feed</span> RSS 全局设置</span>
              <button
                className="push-btn push-btn-sm"
                onClick={onOpenRssSettings}
                style={{ fontSize: 10 }}
              >
                配置
              </button>
            </div>
            <div style={{ marginTop: 4 }}>
              {globalRss?.enabled !== false && globalRss?.repo ? (
                <>
                  <div>仓库: {globalRss.repo}</div>
                  <div>文件: {globalRss.filePath || 'feed.xml'}</div>
                </>
              ) : (
                <span style={{ color: 'var(--accent-orange)' }}>! 尚未配置 RSS</span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="email-push-actions">
            <button className="push-btn push-btn-save" onClick={handleSave}>
              {savedFlag ? '✓ 已保存' : '保存配置'}
            </button>
            <button
              className="push-btn push-btn-crawl"
              onClick={handleCrawl}
              disabled={loading}
            >
              {loading && crawlingAccountId === activeAccount?.id ? '爬取中...' : '爬取仓库'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
