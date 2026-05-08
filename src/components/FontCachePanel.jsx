import React, { useState, useEffect, useCallback } from 'react';

const sizeLabel = (kb) => (kb >= 1000 ? `${(kb / 1000).toFixed(1)} MB` : `~${kb} KB`);

export default function FontCachePanel() {
  const [status, setStatus] = useState({ loading: true, resources: [] });
  const [downloading, setDownloading] = useState(false);

  const checkCache = useCallback(async () => {
    setStatus({ loading: true, resources: [] });
    try {
      const res = await window.electronAPI.checkFontCache();
      setStatus({ loading: false, resources: res.resources || [], error: null });
    } catch (e) {
      setStatus({ loading: false, resources: [], error: e.message });
    }
  }, []);

  useEffect(() => {
    checkCache();
  }, [checkCache]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await window.electronAPI.downloadFontCache();
      if (res.ok) {
        await checkCache();
      } else {
        const failed = (res.results || []).filter((r) => !r.cached).map((r) => r.key).join(', ');
        setStatus((s) => ({ ...s, error: res.message + (failed ? `（${failed}）` : '') }));
      }
    } catch (e) {
      setStatus((s) => ({ ...s, error: e.message }));
    } finally {
      setDownloading(false);
    }
  };

  const items = status.resources;
  const cachedCount = items.filter((f) => f.cached).length;
  const totalCount = items.length;
  const allCached = totalCount > 0 && cachedCount === totalCount;
  const noneCached = totalCount > 0 && cachedCount === 0;

  return (
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-icons" style={{ fontSize: 18, color: 'var(--accent)' }}>
          cloud_download
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          离线资源缓存
        </span>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
        将轮播页面依赖的图标字体和样式脚本下载到本地。缓存后生成 HTML 完全不依赖外网，离线也能正常显示。
      </p>

      {status.loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '20px 0', textAlign: 'center' }}>
          检查缓存状态...
        </div>
      ) : status.error ? (
        <div style={{
          fontSize: 12, color: '#f85149', padding: '8px 12px',
          background: 'rgba(248,81,73,0.08)', borderRadius: 6,
        }}>
          {status.error}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((res) => (
            <div
              key={res.key}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', borderRadius: 6,
                background: res.cached ? 'rgba(63,185,80,0.06)' : 'rgba(140,140,140,0.06)',
                border: `1px solid ${res.cached ? 'rgba(63,185,80,0.2)' : 'rgba(48,54,61,0.6)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-icons" style={{
                  fontSize: 14,
                  color: res.cached ? '#3fb950' : 'var(--text-secondary)',
                }}>
                  {res.cached ? 'check_circle' : 'cloud_off'}
                </span>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{res.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {res.cached ? `已缓存 · ${sizeLabel(res.sizeKb)}` : `需下载 · ${sizeLabel(res.sizeKb)}`} · {res.desc}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={handleDownload}
        disabled={downloading || status.loading || allCached}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          width: '100%', padding: '8px 14px', borderRadius: 6,
          border: `1px solid ${allCached ? 'rgba(63,185,80,0.3)' : 'var(--border)'}`,
          background: allCached
            ? 'rgba(63,185,80,0.08)'
            : noneCached
              ? 'var(--accent)'
              : 'rgba(88,166,255,0.08)',
          color: allCached
            ? '#3fb950'
            : noneCached
              ? '#fff'
              : 'var(--accent)',
          fontSize: 12, cursor: allCached ? 'default' : 'pointer',
          fontFamily: 'inherit', fontWeight: noneCached ? 600 : 400,
          transition: 'all 0.15s',
          opacity: (downloading || status.loading) ? 0.7 : 1,
        }}
      >
        <span className="material-icons" style={{ fontSize: 16 }}>
          {allCached ? 'check' : downloading ? 'sync' : 'cloud_download'}
        </span>
        <span>
          {allCached ? '全部已缓存' : downloading ? '下载中...' : `一键下载全部 (${cachedCount}/${totalCount})`}
        </span>
      </button>
    </div>
  );
}
