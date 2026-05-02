import React, { useEffect, useState, useMemo, memo } from 'react';

const VISIBLE_BATCH = 200;

const RepoCard = memo(function RepoCard({ repo }) {
  return (
    <div className="repo-history-card">
      <div className="repo-history-card-header">
        <a
          className="repo-history-name"
          href={repo.url}
          onClick={(e) => {
            e.preventDefault();
            window.electronAPI.openUrl(repo.url);
          }}
          title={repo.name}
        >
          {repo.name}
        </a>
        {repo.hasCarousel && (
          <span className="repo-history-carousel-badge" title="已生成 README 车播">
            <span className="material-icons" style={{ fontSize: 10 }}>slideshow</span>
            车播
          </span>
        )}
      </div>
      {repo.tags && repo.tags.length > 0 && (
        <div className="repo-history-tags">
          {repo.tags.map((tag) => (
            <span key={tag} className="repo-history-tag">{tag}</span>
          ))}
        </div>
      )}
      {repo.description && (
        <div className="repo-history-desc">{repo.description}</div>
      )}
      <div className="repo-history-meta">
        <span className="repo-history-stat">
          <span className="material-icons" style={{ fontSize: 11 }}>star</span>
          {repo.stars ?? '—'}
        </span>
        <span className="repo-history-stat">
          <span className="material-icons" style={{ fontSize: 11 }}>call_split</span>
          {repo.forks ?? '—'}
        </span>
        {repo.updated && (
          <span className="repo-history-date">{repo.updated}</span>
        )}
      </div>
    </div>
  );
});

export default function RepoHistoryPanel() {
  const [allRepos, setAllRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [carouselCount, setCarouselCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const result = await window.electronAPI.loadRepoHistory(1, 50000);
        if (disposed) return;
        if (result?.ok) {
          setAllRepos(result.repos || []);
          setCarouselCount(result.carouselCount || 0);
        } else {
          setError(result?.message || '加载失败');
        }
      } catch (e) {
        if (!disposed) setError(e.message || '加载失败');
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    load();
    return () => { disposed = true; };
  }, []);

  // 同步过滤，不用 useDeferredValue，保持显示一致
  const filtered = useMemo(() => {
    if (!search.trim()) return allRepos;
    const q = search.toLowerCase();
    return allRepos.filter((repo) => {
      if (repo.name.toLowerCase().includes(q)) return true;
      if (repo.description && repo.description.toLowerCase().includes(q)) return true;
      if (repo.tags && repo.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [allRepos, search]);

  // 搜索条件变化时重置可见数量
  useEffect(() => {
    setVisibleCount(VISIBLE_BATCH);
  }, [search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMoreVisible = visibleCount < filtered.length;

  if (loading) {
    return <div className="repo-history-loading">加载中...</div>;
  }

  if (error) {
    return <div className="repo-history-error">{error}</div>;
  }

  const isSearching = search.trim().length > 0;

  return (
    <div className="repo-history-panel">
      <div className="repo-history-header">
        <div className="repo-history-stats">
          <span>共 {allRepos.length} 个仓库</span>
          {carouselCount > 0 && (
            <span className="repo-history-carousel-stat">
              <span className="material-icons" style={{ fontSize: 12 }}>slideshow</span>
              {carouselCount} 个已生成车播
            </span>
          )}
          {isSearching && (
            <span>筛选出 {filtered.length} 个</span>
          )}
        </div>
        <input
          className="repo-history-search"
          type="text"
          placeholder="搜索仓库名称、标签或描述..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <div className="repo-history-empty">
          {isSearching ? '没有匹配的仓库' : '暂无历史仓库数据'}
        </div>
      ) : (
        <div className="repo-history-list">
          {visible.map((repo) => (
            <RepoCard key={repo.name} repo={repo} />
          ))}
          {hasMoreVisible && (
            <button
              className="repo-history-show-more"
              onClick={() => setVisibleCount((prev) => prev + VISIBLE_BATCH)}
            >
              显示更多（当前 {visibleCount} / 共 {filtered.length} 个）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
