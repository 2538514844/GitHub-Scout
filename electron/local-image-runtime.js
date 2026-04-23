function hasLocalImageViewerMarkup(htmlContent) {
  return /local-image-modal|local-image-view|image-time-short-notice/i.test(
    String(htmlContent || ''),
  );
}

function buildLocalImageRuntimeStyleTag() {
  return `<style id="repo-local-image-runtime-style">
:root {
  --repo-local-image-padding: clamp(24px, 3vw, 56px);
}

.local-image-modal {
  box-sizing: border-box !important;
  padding: var(--repo-local-image-padding) !important;
}

.local-image-view {
  display: block !important;
  width: min(1320px, 66vw, calc(100vw - var(--repo-local-image-padding) * 2)) !important;
  height: min(820px, 70vh, calc(100vh - var(--repo-local-image-padding) * 2)) !important;
  max-width: calc(100vw - var(--repo-local-image-padding) * 2) !important;
  max-height: calc(100vh - var(--repo-local-image-padding) * 2) !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: auto !important;
  object-fit: contain !important;
  object-position: center center !important;
}

@media (max-width: 960px), (max-height: 720px) {
  :root {
    --repo-local-image-padding: 16px;
  }

  .local-image-view {
    width: min(92vw, calc(100vw - var(--repo-local-image-padding) * 2)) !important;
    height: min(78vh, calc(100vh - var(--repo-local-image-padding) * 2)) !important;
  }
}
</style>`;
}

function injectLocalImageRuntimeStyle(htmlContent) {
  const html = String(htmlContent || '').trim();
  if (!html || !hasLocalImageViewerMarkup(html)) {
    return html;
  }

  const styleTag = buildLocalImageRuntimeStyleTag();
  const withoutOldStyle = html.replace(
    /\s*<style[^>]+id=["']repo-local-image-runtime-style["'][\s\S]*?<\/style>/ig,
    '',
  );

  if (/<\/head>/i.test(withoutOldStyle)) {
    return withoutOldStyle.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }

  if (/<head[^>]*>/i.test(withoutOldStyle)) {
    return withoutOldStyle.replace(/<head([^>]*)>/i, `<head$1>\n${styleTag}`);
  }

  if (/<html[^>]*>/i.test(withoutOldStyle)) {
    return withoutOldStyle.replace(/<html([^>]*)>/i, `<html$1><head>${styleTag}</head>`);
  }

  return `<!DOCTYPE html><html><head>${styleTag}</head><body>${withoutOldStyle}</body></html>`;
}

module.exports = {
  injectLocalImageRuntimeStyle,
};
