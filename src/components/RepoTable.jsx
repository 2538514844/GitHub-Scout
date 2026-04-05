import React, { useState, useMemo, useEffect, useRef } from 'react';

function RepoTable({ repos, repoTags = {}, selectedRepoName }) {
  const [sortKey, setSortKey] = useState('stars');
  const [sortDir, setSortDir] = useState('desc');
  const [filterLang, setFilterLang] = useState('');
  const [searchText, setSearchText] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [highlightName, setHighlightName] = useState(null);
  const tableRef = useRef(null);

  const allTags = useMemo(() => {
    const tagSet = new Set();
    Object.values(repoTags).forEach(({ tags }) => tags.forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  }, [repoTags]);

  const languages = useMemo(() => {
    const langs = new Set();
    repos.forEach(r => langs.add(r.language));
    return [...langs].sort();
  }, [repos]);

  const sortedRepos = useMemo(() => {
    let filtered = repos;
    if (filterLang) filtered = filtered.filter(r => r.language === filterLang);
    if (tagFilter) filtered = filtered.filter(r => {
      const t = repoTags[r.name];
      return t && t.tags.some(tag => tag.toLowerCase().includes(tagFilter.toLowerCase()));
    });
    if (searchText) {
      const q = searchText.toLowerCase();
      filtered = filtered.filter(r =>
        r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
      );
    }
    return [...filtered].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [repos, sortKey, sortDir, filterLang, searchText, tagFilter]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // Scroll to and highlight selected repo
  useEffect(() => {
    if (!selectedRepoName || !tableRef.current) return;
    setHighlightName(selectedRepoName);
    const row = tableRef.current.querySelector(`tr[data-repo="${selectedRepoName}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const timer = setTimeout(() => setHighlightName(null), 3000);
    return () => clearTimeout(timer);
  }, [selectedRepoName]);

  const sortIcon = (key) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const tagFilterRef = useRef(null);
  const [showTagDropdown, setShowTagDropdown] = useState(false);

  // Close tag dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (showTagDropdown && tagFilterRef.current && !tagFilterRef.current.contains(e.target)) {
        setShowTagDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTagDropdown]);

  const filteredTags = useMemo(() => {
    if (!tagFilter) return allTags;
    return allTags.filter(t => t.toLowerCase().includes(tagFilter.toLowerCase()));
  }, [allTags, tagFilter]);

  const handleTagSelect = (tag) => {
    setTagFilter(tag);
    setShowTagDropdown(false);
  };

  const handleTagInputChange = (e) => {
    setTagFilter(e.target.value);
    setShowTagDropdown(true);
  };

  const clearTagFilter = () => {
    setTagFilter('');
    setShowTagDropdown(false);
  };

  if (repos.length === 0) {
    return (
      <div className="repo-table-placeholder">
        <div className="placeholder-icon">github</div>
        <p>点击「一键爬取」获取近3天热门仓库</p>
      </div>
    );
  }

  return (
    <div className="repo-section">
      <div className="repo-toolbar">
        <div className="toolbar-left">
          <span className="repo-count">{sortedRepos.length} / {repos.length} 个仓库</span>
        </div>
        <div className="toolbar-right">
          <input
            type="text"
            className="search-input"
            placeholder="搜索仓库名或描述..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
          <div className="tag-filter-wrapper" ref={tagFilterRef}>
            <input
              type="text"
              className="tag-filter-input"
              placeholder="搜索标签..."
              value={tagFilter}
              onChange={handleTagInputChange}
              onFocus={() => allTags.length > 0 && setShowTagDropdown(true)}
            />
            {showTagDropdown && filteredTags.length > 0 && (
              <div className="tag-dropdown">
                {filteredTags.map(tag => (
                  <div
                    key={tag}
                    className={`tag-dropdown-item ${tagFilter === tag ? 'active' : ''}`}
                    onClick={() => handleTagSelect(tag)}
                  >
                    {tag}
                  </div>
                ))}
              </div>
            )}
            {tagFilter && (
              <button className="tag-filter-clear" onClick={clearTagFilter} title="清除标签过滤">×</button>
            )}
          </div>
          <select
            className="lang-filter"
            value={filterLang}
            onChange={e => setFilterLang(e.target.value)}
          >
            <option value="">全部语言</option>
            {languages.map(lang => (
              <option key={lang} value={lang}>{lang}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="table-wrapper">
        <table className="repo-table" ref={tableRef}>
          <thead>
            <tr>
              <th onClick={() => handleSort('name')} className="sortable">
                仓库{sortIcon('name')}
              </th>
              <th onClick={() => handleSort('language')} className="sortable">
                语言{sortIcon('language')}
              </th>
              <th onClick={() => handleSort('stars')} className="sortable">
                Stars{sortIcon('stars')}
              </th>
              <th onClick={() => handleSort('forks')} className="sortable">
                Forks{sortIcon('forks')}
              </th>
              <th onClick={() => handleSort('created')} className="sortable">
                创建{sortIcon('created')}
              </th>
              <th>描述</th>
            </tr>
          </thead>
          <tbody>
            {sortedRepos.map((repo, i) => (
              <tr key={repo.name} data-repo={repo.name} className={highlightName === repo.name ? 'highlight' : ''} onClick={() => window.open(repo.url, '_blank')}>
                <td className="repo-name">{repo.name}</td>
                <td><span className="lang-badge">{repo.language}</span></td>
                <td className="stars">{repo.stars.toLocaleString()}</td>
                <td>{repo.forks.toLocaleString()}</td>
                <td>{repo.created}</td>
                <td className="description">{repo.description?.substring(0, 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default RepoTable;
