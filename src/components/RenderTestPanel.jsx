import React, { useState, useEffect, useCallback } from 'react';

function formatMs(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function speedup(nvencMs, cpuMs) {
  if (!nvencMs || !cpuMs || nvencMs <= 0 || cpuMs <= 0) return null;
  return (cpuMs / nvencMs).toFixed(1);
}

export default function RenderTestPanel() {
  const [state, setState] = useState({ status: 'idle', results: null, error: null });

  const runTest = useCallback(async () => {
    setState({ status: 'running', results: null, error: null });
    try {
      const res = await window.electronAPI.testRender();
      if (!res.ok) {
        setState({ status: 'done', results: res.results, error: res.results?.message || '测试返回异常' });
      } else {
        setState({ status: 'done', results: res.results, error: null });
      }
    } catch (e) {
      setState({ status: 'done', results: null, error: e.message });
    }
  }, []);

  useEffect(() => {
    runTest();
  }, [runTest]);

  const r = state.results;
  const running = state.status === 'running';
  const sp = r ? speedup(r.nvencDurationMs, r.cpuDurationMs) : null;

  return (
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-icons" style={{ fontSize: 18, color: 'var(--accent)' }}>
          videocam
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          渲染管线测试
        </span>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
        检测 ffmpeg、NVENC 硬件加速可用性，并分别测试 NVENC 和 CPU 编码管线。
      </p>

      {running && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
          padding: '20px 0', fontSize: 12, color: 'var(--text-secondary)',
        }}>
          <span className="material-icons" style={{ fontSize: 16, animation: 'spin 1s linear infinite' }}>
            sync
          </span>
          测试中...
        </div>
      )}

      {state.error && !r && (
        <div style={{
          fontSize: 12, color: '#f85149', padding: '8px 12px',
          background: 'rgba(248,81,73,0.08)', borderRadius: 6,
        }}>
          {state.error}
        </div>
      )}

      {r && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Summary banner */}
          <div style={{
            padding: '10px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
            background: r.nvencSuccess
              ? 'rgba(63,185,80,0.08)'
              : r.cpuSuccess
                ? 'rgba(210,153,34,0.08)'
                : 'rgba(248,81,73,0.08)',
            border: `1px solid ${
              r.nvencSuccess ? 'rgba(63,185,80,0.3)'
                : r.cpuSuccess ? 'rgba(210,153,34,0.3)'
                  : 'rgba(248,81,73,0.3)'
            }`,
            color: r.nvencSuccess ? '#3fb950' : r.cpuSuccess ? '#d29922' : '#f85149',
          }}>
            {r.nvencSuccess
              ? `NVENC 硬件加速正常${sp ? ` · 比 CPU 快 ${sp}x` : ''}`
              : r.nvencAvailable && !r.nvencSuccess
                ? `NVENC 测试失败 · 回退 CPU`
                : r.cpuSuccess
                  ? 'NVENC 不可用 · CPU 软编码正常'
                  : '所有编码路径均失败'}
          </div>

          {/* NVENC row */}
          <div style={{
            padding: '8px 12px', borderRadius: 6,
            background: r.nvencSuccess ? 'rgba(63,185,80,0.06)' : 'rgba(140,140,140,0.06)',
            border: `1px solid ${r.nvencSuccess ? 'rgba(63,185,80,0.2)' : 'rgba(48,54,61,0.6)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" style={{
                fontSize: 14,
                color: r.nvencSuccess ? '#3fb950' : r.nvencAvailable ? '#d29922' : 'var(--text-secondary)',
              }}>
                {r.nvencSuccess ? 'check_circle' : r.nvencAvailable ? 'error' : 'remove_circle'}
              </span>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  NVENC 硬件加速 (h264_nvenc)
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {r.nvencAvailable === false
                    ? '编码器未检测到'
                    : r.nvencSuccess
                      ? `编码成功 · 耗时 ${formatMs(r.nvencDurationMs)}`
                      : `编码失败${r.nvencError ? ': ' + r.nvencError : ''}`}
                </div>
              </div>
            </div>
          </div>

          {/* CPU row */}
          <div style={{
            padding: '8px 12px', borderRadius: 6,
            background: r.cpuSuccess ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)',
            border: `1px solid ${r.cpuSuccess ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" style={{
                fontSize: 14,
                color: r.cpuSuccess ? '#3fb950' : '#f85149',
              }}>
                {r.cpuSuccess ? 'check_circle' : 'error'}
              </span>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  CPU 软编码 (libx264)
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {r.cpuSuccess
                    ? `编码成功 · 耗时 ${formatMs(r.cpuDurationMs)}`
                    : `编码失败${r.cpuError ? ': ' + r.cpuError : ''}`}
                </div>
              </div>
            </div>
          </div>

          {/* ffmpeg check */}
          <div style={{
            padding: '8px 12px', borderRadius: 6,
            background: r.ffmpegFound ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)',
            border: `1px solid ${r.ffmpegFound ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-icons" style={{
                fontSize: 14,
                color: r.ffmpegFound ? '#3fb950' : '#f85149',
              }}>
                {r.ffmpegFound ? 'check_circle' : 'error'}
              </span>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>ffmpeg 可用性</div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {r.ffmpegFound ? '已就绪' : '未找到 ffmpeg'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={runTest}
        disabled={running}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          width: '100%', padding: '8px 14px', borderRadius: 6,
          border: '1px solid var(--border)',
          background: running ? 'rgba(140,140,140,0.08)' : 'var(--accent)',
          color: running ? 'var(--text-secondary)' : '#fff',
          fontSize: 12, cursor: running ? 'default' : 'pointer',
          fontFamily: 'inherit', fontWeight: 600,
          transition: 'all 0.15s',
          opacity: running ? 0.7 : 1,
        }}
      >
        <span className="material-icons" style={{ fontSize: 16 }}>
          {running ? 'sync' : 'refresh'}
        </span>
        <span>{running ? '测试中...' : '重新测试'}</span>
      </button>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
