import React, { useRef, useEffect, useState } from 'react';

const LEVEL_COLORS = {
  info: '#58a6ff',
  success: '#3fb950',
  error: '#f85149',
  warn: '#d29922',
};

function LogPanel({ logs, title = '日志', collapsed: initialCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const logEndRef = useRef(null);

  useEffect(() => {
    if (logEndRef.current && !collapsed) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, collapsed]);

  if (logs.length === 0) return null;

  return (
    <div className="log-panel">
      <div className="log-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="log-title">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75v-8.5ZM2 3.5v7h12v-7H2Zm2 1.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Zm3.5 0a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75ZM2 12v-1.25h12V12H2Z"/>
          </svg>
          {title} ({logs.length})
        </span>
        <span className="log-toggle">{collapsed ? '展开' : '收起'}</span>
      </div>
      {!collapsed && (
        <div className="log-content">
          {logs.map((entry, i) => (
            <div key={i} className={`log-entry log-${entry.level}`}>
              <span className="log-time">{entry.time}</span>
              <span
                className="log-level"
                style={{ color: LEVEL_COLORS[entry.level] || LEVEL_COLORS.info }}
              >
                [{entry.level.toUpperCase()}]
              </span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

export default LogPanel;
