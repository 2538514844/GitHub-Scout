import React, { useState, useMemo, useEffect, useRef } from 'react';

const TEXT = {
  emptyHint: '\u70B9\u51FB\u300C\u4E00\u952E\u722C\u53D6\u300D\u83B7\u53D6\u8FD1 3 \u5929\u70ED\u95E8\u4ED3\u5E93',
  selectedPrefix: '\u5DF2\u9009 ',
  searchPlaceholder: '\u641C\u7D22\u4ED3\u5E93\u540D\u6216\u63CF\u8FF0...',
  tagPlaceholder: '\u641C\u7D22\u6807\u7B7E...',
  clearTagFilter: '\u6E05\u9664\u6807\u7B7E\u8FC7\u6EE4',
  allLanguages: '\u5168\u90E8\u8BED\u8A00',
  selectAllVisible: '\u5168\u9009\u5F53\u524D\u7B5B\u9009\u7ED3\u679C',
  deselectAllVisible: '\u53D6\u6D88\u5F53\u524D\u7B5B\u9009\u7ED3\u679C',
  checkRepo: '\u52FE\u9009\u4ED3\u5E93',
  uncheckRepo: '\u53D6\u6D88\u52FE\u9009',
  name: '\u4ED3\u5E93',
  language: '\u8BED\u8A00',
  created: '\u521B\u5EFA',
  description: '\u63CF\u8FF0',
};

function RepoTable({
  repos,
  repoTags = {},
  selectedRepoName,
  selectedRepoNames = [],
  onSelectionChange,
}) {
  const [sortKey, setSortKey] = useState('stars');
  const [sortDir, setSortDir] = useState('desc');
  const [filterLang, setFilterLang] = useState('');
  const [searchText, setSearchText] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [highlightName, setHighlightName] = useState(null);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const tableRef = useRef(null);
  const tagFilterRef = useRef(null);
  const selectAllRef = useRef(null);

  const selectedRepoSet = useMemo(() => new Set(selectedRepoNames), [selectedRepoNames]);

  const allTags = useMemo(() => {
    const tagSet = new Set();
    Object.values(repoTags).forEach(({ tags }) => tags.forEach(tag => tagSet.add(tag)));
    return [...tagSet].sort();
  }, [repoTags]);

  const languages = useMemo(() => {
    const langs = new Set();
    repos.forEach(repo => langs.add(repo.language));
    return [...langs].sort();
  }, [repos]);

  const sortedRepos = useMemo(() => {
    let filtered = repos;

    if (filterLang) {
      filtered = filtered.filter(repo => repo.language === filterLang);
    }

    if (tagFilter) {
      filtered = filtered.filter(repo => {
        const tagInfo = repoTags[repo.name];
        return tagInfo && tagInfo.tags.some(tag => tag.toLowerCase().includes(tagFilter.toLowerCase()));
      });
    }

    if (searchText) {
      const query = searchText.toLowerCase();
      filtered = filtered.filter(repo =>
        repo.name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query)
      );
    }

    return [...filtered].sort((a, b) => {
      let va = a[sortKey];
      let vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [repos, sortKey, sortDir, filterLang, searchText, tagFilter, repoTags]);

  const visibleRepoNames = useMemo(
    () => sortedRepos.map(repo => repo.name),
    [sortedRepos]
  );

  const selectedVisibleCount = useMemo(
    () => visibleRepoNames.filter(name => selectedRepoSet.has(name)).length,
    [visibleRepoNames, selectedRepoSet]
  );

  const allVisibleSelected = visibleRepoNames.length > 0 && selectedVisibleCount === visibleRepoNames.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

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

  useEffect(() => {
    const handler = (event) => {
      if (showTagDropdown && tagFilterRef.current && !tagFilterRef.current.contains(event.target)) {
        setShowTagDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTagDropdown]);

  const filteredTags = useMemo(() => {
    if (!tagFilter) return allTags;
    return allTags.filter(tag => tag.toLowerCase().includes(tagFilter.toLowerCase()));
  }, [allTags, tagFilter]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('desc');
  };

  const sortIcon = (key) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const handleTagSelect = (tag) => {
    setTagFilter(tag);
    setShowTagDropdown(false);
  };

  const clearTagFilter = () => {
    setTagFilter('');
    setShowTagDropdown(false);
  };

  const updateSelection = (updater) => {
    if (!onSelectionChange) return;
    onSelectionChange(updater);
  };

  const toggleRepoSelection = (repoName) => {
    updateSelection((current) => (
      current.includes(repoName)
        ? current.filter(name => name !== repoName)
        : [...current, repoName]
    ));
  };

  const toggleVisibleSelection = () => {
    updateSelection((current) => {
      if (allVisibleSelected) {
        return current.filter(name => !visibleRepoNames.includes(name));
      }

      const next = new Set(current);
      visibleRepoNames.forEach(name => next.add(name));
      return [...next];
    });
  };

  if (repos.length === 0) {
    return (
      <div className="repo-table-placeholder">
        <div className="placeholder-icon">github</div>
        <p>{TEXT.emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="repo-section">
      <div className="repo-toolbar">
        <div className="toolbar-left">
          <span className="repo-count">{`${sortedRepos.length} / ${repos.length}`}</span>
          <span className="repo-count-label">{TEXT.name}</span>
          {selectedRepoNames.length > 0 && (
            <span className="repo-selected-count">{`${TEXT.selectedPrefix}${selectedRepoNames.length}`}</span>
          )}
        </div>
        <div className="toolbar-right">
          <input
            type="text"
            className="search-input"
            placeholder={TEXT.searchPlaceholder}
            value={searchText}
            onChange={event => setSearchText(event.target.value)}
          />
          <div className="tag-filter-wrapper" ref={tagFilterRef}>
            <input
              type="text"
              className="tag-filter-input"
              placeholder={TEXT.tagPlaceholder}
              value={tagFilter}
              onChange={(event) => {
                setTagFilter(event.target.value);
                setShowTagDropdown(true);
              }}
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
              <button className="tag-filter-clear" onClick={clearTagFilter} title={TEXT.clearTagFilter}>×</button>
            )}
          </div>
          <select
            className="lang-filter"
            value={filterLang}
            onChange={event => setFilterLang(event.target.value)}
          >
            <option value="">{TEXT.allLanguages}</option>
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
              <th className="checkbox-column">
                <input
                  ref={selectAllRef}
                  className="repo-checkbox"
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisibleSelection}
                  title={allVisibleSelected ? TEXT.deselectAllVisible : TEXT.selectAllVisible}
                />
              </th>
              <th onClick={() => handleSort('name')} className="sortable">
                {TEXT.name}{sortIcon('name')}
              </th>
              <th onClick={() => handleSort('language')} className="sortable">
                {TEXT.language}{sortIcon('language')}
              </th>
              <th onClick={() => handleSort('stars')} className="sortable">
                Stars{sortIcon('stars')}
              </th>
              <th onClick={() => handleSort('forks')} className="sortable">
                Forks{sortIcon('forks')}
              </th>
              <th onClick={() => handleSort('created')} className="sortable">
                {TEXT.created}{sortIcon('created')}
              </th>
              <th>{TEXT.description}</th>
            </tr>
          </thead>
          <tbody>
            {sortedRepos.map((repo) => {
              const selected = selectedRepoSet.has(repo.name);
              const rowClassName = [
                highlightName === repo.name ? 'highlight' : '',
                selected ? 'selected' : '',
              ].filter(Boolean).join(' ');

              return (
                <tr
                  key={repo.name}
                  data-repo={repo.name}
                  className={rowClassName}
                  onClick={() => window.open(repo.url, '_blank')}
                >
                  <td className="checkbox-column checkbox-cell" onClick={event => event.stopPropagation()}>
                    <input
                      className="repo-checkbox"
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleRepoSelection(repo.name)}
                      title={selected ? TEXT.uncheckRepo : TEXT.checkRepo}
                    />
                  </td>
                  <td className="repo-name">{repo.name}</td>
                  <td><span className="lang-badge">{repo.language}</span></td>
                  <td className="stars">{repo.stars.toLocaleString()}</td>
                  <td>{repo.forks.toLocaleString()}</td>
                  <td>{repo.created}</td>
                  <td className="description">{repo.description?.substring(0, 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default RepoTable;
