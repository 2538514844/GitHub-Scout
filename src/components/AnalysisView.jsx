import React, { useState, useCallback, useEffect } from 'react';

function AnalysisView({ analysis, repoUrlMap = {}, onRepoClick }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(false);
  }, [analysis?.title, analysis?.content, analysis?.message]);

  if (!analysis) return null;

  const panelTitle = analysis.title || 'AI \u8F93\u51FA';
  const errorLabel = analysis.errorLabel || '\u8F93\u51FA\u5931\u8D25';
  const expandLabel = '\u5C55\u5F00';
  const collapseLabel = '\u6536\u8D77';

  const renderContent = () => {
    let html = analysis.content || '';

    html = html
      .replace(/\r\n/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const placeholders = [];
    const makePlaceholder = (data) => {
      const tag = `\x00${placeholders.length}\x00`;
      placeholders.push(data);
      return tag;
    };

    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, text, url) => {
      return makePlaceholder({ type: 'external', text, url });
    });

    html = html.replace(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/g, (match, repoName) => {
      return makePlaceholder({ type: 'repoUrl', text: match, url: match, repoName });
    });

    html = html.replace(/([\w.-]+\/[\w.-]+)/g, (match, repoName) => {
      if (repoUrlMap[repoName]) {
        return makePlaceholder({ type: 'repo', text: repoName, repoName });
      }
      return match;
    });

    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/<br>\s*(<h[234]>)/g, '$1');
    html = html.replace(/(<\/h[234]>)\s*<br>/g, '$1');
    html = html.replace(/<br>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<br>/g, '$1');

    html = html.replace(/\x00(\d+)\x00/g, (match, idx) => {
      const placeholder = placeholders[parseInt(idx, 10)];
      if (!placeholder) return '';

      if (placeholder.type === 'repo' || placeholder.type === 'repoUrl') {
        const href = placeholder.url || repoUrlMap[placeholder.repoName];
        return `<a href="${href}" class="analysis-repo-link" data-repo="${placeholder.repoName}">${placeholder.text}</a>`;
      }

      return `<a href="${placeholder.url}" class="analysis-external-link" data-url="${placeholder.url}">${placeholder.text}</a>`;
    });

    return html;
  };

  const handleClick = useCallback((event) => {
    const repoLink = event.target.closest('a.analysis-repo-link');
    if (repoLink) {
      const repoName = repoLink.getAttribute('data-repo');
      if (repoName && onRepoClick) {
        event.preventDefault();
        onRepoClick(repoName);
      }
      return;
    }

    const externalLink = event.target.closest('a.analysis-external-link');
    if (externalLink) {
      const url = externalLink.getAttribute('data-url');
      if (url) {
        event.preventDefault();
        window.electronAPI.openUrl(url);
      }
    }
  }, [onRepoClick]);

  if (!analysis.ok) {
    return (
      <div className="analysis-section">
        <div className="analysis-header">
          <h3>{panelTitle}</h3>
          <button
            className="analysis-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? expandLabel : collapseLabel}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}
            >
              <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z" />
            </svg>
          </button>
        </div>
        {!collapsed && (
          <div className="analysis-error">
            {errorLabel}: {analysis.message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="analysis-section">
      <div className="analysis-header">
        <h3>{panelTitle} {analysis.model && <span className="analysis-model">{analysis.model}</span>}</h3>
        <button
          className="analysis-collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? expandLabel : collapseLabel}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}
          >
            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z" />
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
