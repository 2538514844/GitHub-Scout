import { useState, useCallback } from 'react';

export default function GlobalSmtpSettings({ smtp, onSave }) {
  const [draft, setDraft] = useState(() => ({
    host: smtp?.host || '',
    port: smtp?.port || 587,
    user: smtp?.user || '',
    pass: smtp?.pass || '',
    useTls: smtp?.useTls !== false,
  }));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [savedFlag, setSavedFlag] = useState(null);

  const updateDraft = useCallback((key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  }, []);

  const handleTest = useCallback(async () => {
    if (!draft.host) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testGlobalSmtp(draft);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  }, [draft]);

  const handleSave = useCallback(async () => {
    await onSave(draft);
    setSavedFlag(Date.now());
    setTimeout(() => setSavedFlag(null), 1500);
  }, [draft, onSave]);

  return (
    <div className="smtp-settings-panel">
      <div className="email-push-header">SMTP 全局设置</div>
      <div className="email-push-form">
        <div className="smtp-hint" style={{
          padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)',
          background: 'rgba(88, 166, 255, 0.08)', borderRadius: 6, marginBottom: 10,
          border: '1px solid rgba(88, 166, 255, 0.15)', lineHeight: 1.5,
        }}>
          所有邮箱账户共用此 SMTP 配置。修改后所有账户的邮件发送都将使用新的服务器设置。
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          <span>SMTP 服务器</span>
          <input
            type="text"
            value={draft.host}
            onChange={(e) => updateDraft('host', e.target.value)}
            placeholder="smtp.gmail.com"
            style={{
              padding: 6, border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg)', color: 'var(--text)', fontSize: 12,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          <span>端口</span>
          <input
            type="number"
            value={draft.port}
            onChange={(e) => updateDraft('port', parseInt(e.target.value, 10) || 587)}
            style={{
              padding: 6, border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg)', color: 'var(--text)', fontSize: 12, width: 120,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          <span>用户名</span>
          <input
            type="text"
            value={draft.user}
            onChange={(e) => updateDraft('user', e.target.value)}
            placeholder="your-email@gmail.com"
            style={{
              padding: 6, border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg)', color: 'var(--text)', fontSize: 12,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
          <span>密码 / 应用专用密码</span>
          <input
            type="password"
            value={draft.pass}
            onChange={(e) => updateDraft('pass', e.target.value)}
            placeholder="SMTP 密码"
            style={{
              padding: 6, border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg)', color: 'var(--text)', fontSize: 12,
            }}
          />
        </label>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0',
          fontSize: 11, color: 'var(--text-secondary)',
        }}>
          <input
            type="checkbox"
            checked={draft.useTls}
            onChange={(e) => updateDraft('useTls', e.target.checked)}
          />
          <span>使用 TLS</span>
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
          <button
            className="push-btn push-btn-test"
            onClick={handleTest}
            disabled={testing || !draft.host}
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
          {testResult && (
            <span className={`push-test-msg ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok ? '✓ 成功' : `✗ ${testResult.message}`}
            </span>
          )}
        </div>

        <div className="email-push-actions">
          <button className="push-btn push-btn-save" onClick={handleSave}>
            {savedFlag ? '✓ 已保存' : '保存 SMTP 设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
