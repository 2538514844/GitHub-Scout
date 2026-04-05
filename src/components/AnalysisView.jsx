import React, { useState, useCallback } from 'react';

function AnalysisView({ analysis, repoUrlMap = {}, onRepoClick }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!analysis) return null;

  if (!analysis.ok) {
    return (
      <div className="analysis-section">
        <div className="analysis-header">
          <h3>AI 分析</h3>
          <button className="analysis-collapse-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开' : '收起'}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>
              <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
            </svg>
          </button>
        </div>
        <div className="analysis-error">
          分析失败: {analysis.message}
        </div>
      </div>
    );
  }

  const renderContent = () => {
    let html = analysis.content;

    // Strip invisible/control characters (except newlines, tabs, common whitespace)
    html = html.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

    // Escape HTML
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Use placeholders to avoid double-matching
    const placeholders = [];
    const makePlaceholder = (data) => {
      const tag = `\x00${placeholders.length}\x00`;
      placeholders.push(data);
      return tag;
    };

    // Step 1: Convert GitHub URLs to placeholder links
    html = html.replace(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/g, (match, repoName) => {
      return makePlaceholder({ type: 'url', url: match, repoName });
    });

    // Step 2: Convert bare owner/repo patterns (only if in repoUrlMap)
    html = html.replace(/([\w.-]+\/[\w.-]+)/g, (match, repoName) => {
      if (repoUrlMap[repoName]) {
        return makePlaceholder({ type: 'repo', repoName });
      }
      return match;
    });

    // Step 3: Convert bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Step 4: Convert headings
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Step 5: Convert list items
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');

    // Step 6: Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');

    // Step 7: Convert remaining newlines to <br>
    html = html.replace(/\n/g, '<br>');

    // Step 8: Clean up <br> around block elements
    html = html.replace(/<br>\s*(<h[234]>)/g, '$1');
    html = html.replace(/(<\/h[234]>)\s*<br>/g, '$1');
    html = html.replace(/<br>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<br>/g, '$1');

    // Step 9: Replace placeholders with actual <a> tags
    html = html.replace(/\x00(\d+)\x00/g, (match, idx) => {
      const p = placeholders[parseInt(idx)];
      if (p.type === 'url') {
        return `<a href="${p.url}" class="analysis-repo-link" data-repo="${p.repoName}">${p.url}</a>`;
      }
      return `<a href="${repoUrlMap[p.repoName]}" class="analysis-repo-link" data-repo="${p.repoName}">${p.repoName}</a>`;
    });

    return html;
  };

  const handleClick = useCallback((e) => {
    const link = e.target.closest('a.analysis-repo-link');
    if (link) {
      const repoName = link.getAttribute('data-repo');
      if (repoName && onRepoClick) {
        e.preventDefault();
        onRepoClick(repoName);
      }
    }
  }, [onRepoClick]);

  return (
    <div className="analysis-section">
      <div className="analysis-header">
        <h3>AI 分析 {analysis.model && <span className="analysis-model">{analysis.model}</span>}</h3>
        <button className="analysis-collapse-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开' : '收起'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>
            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
          </svg>
        </button>
      </div>
      {!collapsed && (
        <div
          className="analysis-content"
          dangerouslySetInnerHTML={{ __html: renderContent() }}
          onClick={handleClick}
        />
      )}
    </div>
  );
}

export default AnalysisView;
