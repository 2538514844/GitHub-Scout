export default function Sidebar({ activeTab, onTabChange, accountsCount = 0, children }) {
  const tabs = [
    { key: 'config', label: 'AI 配置', icon: 'tune' },
    { key: 'email-push', label: '个人推送', icon: 'mail', badge: accountsCount > 0 ? accountsCount : null },
    { key: 'smtp', label: 'SMTP 设置', icon: 'send' },
    { key: 'rss', label: 'RSS 设置', icon: 'rss_feed' },
    { key: 'prompts', label: '提示词', icon: 'edit_note' },
  ];

  return (
    <div className="sidebar" style={{
      width: 340, minWidth: 340, flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)',
      animation: 'section-reveal 0.18s ease', overflow: 'hidden',
    }}>
      <div className="sidebar-nav" style={{
        display: 'flex', flexDirection: 'column', padding: 6, gap: 2,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`sidebar-nav-item${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => onTabChange(tab.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', border: 'none', borderRadius: 6,
              background: activeTab === tab.key ? 'rgba(88, 166, 255, 0.1)' : 'transparent',
              color: activeTab === tab.key ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              textAlign: 'left', transition: 'all 0.15s',
            }}
          >
            <span className="material-icons" style={{ fontSize: 16 }}>{tab.icon}</span>
            <span>{tab.label}</span>
            {tab.badge && (
              <span style={{
                marginLeft: 'auto', fontSize: 10, padding: '1px 6px',
                borderRadius: 10, background: 'var(--accent)', color: '#fff',
              }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="sidebar-content" style={{ flex: 1, overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
