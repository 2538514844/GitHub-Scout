import React, { useEffect, useState } from 'react';

const PANEL_STYLE = {
  container: {
    padding: '16px',
    height: '100%',
    overflowY: 'auto',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 12,
    color: '#e0e0e0',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    marginBottom: 6,
    borderRadius: 8,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  itemInfo: {
    flex: 1,
    minWidth: 0,
  },
  itemName: {
    fontSize: 12,
    color: '#ccc',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemMeta: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  recordBtn: {
    flexShrink: 0,
    marginLeft: 10,
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    background: '#e53935',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  empty: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    marginTop: 40,
  },
  loading: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    marginTop: 20,
  },
};

function formatTs(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

export default function LocalRecordPanel() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const result = await window.electronAPI.listCarouselHtmls();
        setSessions(result?.sessions || []);
      } catch {
        setSessions([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleRecord = (session) => {
    window.electronAPI.openReadmeRecorder({ entryHtmlPath: session.indexPath });
  };

  if (loading) return <div style={PANEL_STYLE.loading}>加载中...</div>;

  return (
    <div style={PANEL_STYLE.container}>
      <div style={PANEL_STYLE.title}>
        本地轮播录制 ({sessions.length})
      </div>
      {sessions.length === 0 ? (
        <div style={PANEL_STYLE.empty}>暂无已生成的轮播 HTML</div>
      ) : (
        sessions.map((s) => (
          <div key={s.name} style={PANEL_STYLE.item}>
            <div style={PANEL_STYLE.itemInfo}>
              <div style={PANEL_STYLE.itemName}>{formatTs(s.name)}</div>
              <div style={PANEL_STYLE.itemMeta}>{s.repoCount} 个仓库</div>
            </div>
            <button
              style={PANEL_STYLE.recordBtn}
              onClick={() => handleRecord(s)}
            >
              录制
            </button>
          </div>
        ))
      )}
    </div>
  );
}
