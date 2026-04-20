import React from 'react';

function summarizeFileNames(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return '未选择图片';
  }

  const names = filePaths.map((filePath) => {
    const parts = String(filePath).split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  });

  if (names.length <= 2) {
    return names.join('、');
  }

  return `${names.slice(0, 2).join('、')} 等 ${names.length} 张`;
}

function RepoImagePanel({
  selectedRepos,
  repoImageMap,
  errorMessage = '',
  onPickImages,
  onClearImages,
  onPickImagesSequentially,
}) {
  if (!selectedRepos.length) {
    return null;
  }

  return (
    <section className="repo-image-panel">
      <div className="repo-image-header">
        <div>
          <h3>仓库图片</h3>
          <p>为每个已选仓库选择多张图片，生成时会自动复制到各自输出目录。</p>
        </div>
        <button
          type="button"
          className="repo-image-bulk-btn"
          onClick={onPickImagesSequentially}
        >
          依次选择图片
        </button>
      </div>

      {errorMessage && <div className="test-result error">{errorMessage}</div>}

      <div className="repo-image-list">
        {selectedRepos.map((repo) => {
          const filePaths = repoImageMap[repo.name] || [];

          return (
            <div className="repo-image-card" key={repo.name}>
              <div className="repo-image-meta">
                <strong>{repo.name}</strong>
                <span>{filePaths.length > 0 ? `已选 ${filePaths.length} 张` : '未选择图片'}</span>
                <p>{summarizeFileNames(filePaths)}</p>
              </div>
              <div className="repo-image-actions">
                <button type="button" className="test-btn" onClick={() => onPickImages(repo.name)}>
                  选择图片
                </button>
                <button
                  type="button"
                  className="repo-image-clear-btn"
                  onClick={() => onClearImages(repo.name)}
                  disabled={filePaths.length === 0}
                >
                  清空
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default RepoImagePanel;
