// Standalone juya-style RSS generator + uploader
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── XML helpers (mirror ipc.js) ──

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRfc822Date(d) {
  const date = d ? new Date(d) : new Date();
  if (isNaN(date.getTime())) return toRfc822Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
}

function validXmlChar(c) {
  const cp = c.codePointAt(0);
  return cp === 0x9 || cp === 0xA || cp === 0xD
    || (cp >= 0x20 && cp <= 0xD7FF)
    || (cp >= 0xE000 && cp <= 0xFFFD)
    || (cp >= 0x10000 && cp <= 0x10FFFF);
}

function cleanXml(str) {
  if (!str) return '';
  return String(str).split('').filter(validXmlChar).join('');
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── RSS Builder (juya-style) ──

function renderRepoRssItem(repo) {
  const name = cleanXml(repo.name || '');
  const url = esc(repo.url || `https://github.com/${repo.name}`);
  const desc = repo.description || '';
  const tags = repo.tags || [];
  const stars = repo.stars || 0;
  const forks = repo.forks || 0;
  const dateStr = repo.created || repo.updated || '';
  const pubDate = toRfc822Date(repo.created || repo.updated);

  // Plain text summary (≤360 chars)
  let summary = `${repo.name || ''} — ${desc}`;
  if (tags.length > 0) summary += ` | 标签: ${tags.join(', ')}`;
  summary += ` | ⭐${stars}`;
  if (summary.length > 360) summary = summary.slice(0, 357) + '…';
  summary = cleanXml(summary);

  // Full HTML
  const dateDisplay = dateStr ? dateStr.slice(0, 10) : '';
  const headerLine = [`⭐ ${stars}`, forks ? `🍴 ${forks}` : '', dateDisplay]
    .filter(Boolean).join(' · ');

  const tagHtml = tags.length > 0
    ? tags.map((t) => `<code>${esc(t)}</code>`).join(' ')
    : '';

  const descBlock = desc
    ? `<blockquote>${esc(cleanXml(desc))}</blockquote>`
    : '';

  const html = cleanXml([
    `<h2><a href="${url}">${esc(name)}</a></h2>`,
    `<p>${esc(headerLine)}</p>`,
    descBlock,
    tagHtml ? `<p>标签: ${tagHtml}</p>` : '',
    `<p><a href="${url}">&#128279; 查看仓库</a></p>`,
  ].filter(Boolean).join('\n'));

  const cats = [
    ...tags.map((t) => `      <category>${esc(cleanXml(t))}</category>`),
  ];

  return [
    '    <item>',
    `      <title><![CDATA[${name}]]></title>`,
    `      <link>${url}</link>`,
    `      <author>GitHub Scout</author>`,
    `      <description><![CDATA[${summary}]]></description>`,
    `      <content:encoded><![CDATA[${html}]]></content:encoded>`,
    `      <pubDate>${pubDate}</pubDate>`,
    `      <guid isPermaLink="true">${url}</guid>`,
    ...cats,
    '    </item>',
  ].join('\n');
}

function buildGlobalRssXml(repos, config) {
  const feedUrl = config.publicUrl || `https://2538514844.github.io/feeds/feed.xml`;
  const meta = {
    title: config.title || 'GitHub Scout 每日精选',
    link: config.link || 'https://github.com',
    description: config.description || 'AI 精选 GitHub 热门仓库，每日更新',
    feedUrl,
    buildDate: toRfc822Date(),
    language: 'zh-CN',
  };

  const itemsXml = repos.map(renderRepoRssItem).join('\n');

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title><![CDATA[${meta.title}]]></title>`,
    `    <link>${esc(meta.link)}</link>`,
    `    <description><![CDATA[${meta.description}]]></description>`,
    `    <language>${esc(meta.language)}</language>`,
    `    <lastBuildDate>${meta.buildDate}</lastBuildDate>`,
    `    <docs>http://www.rssboard.org/rss-specification</docs>`,
    `    <generator>GitHub Scout</generator>`,
    `    <atom:link href="${esc(meta.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    itemsXml,
    '  </channel>',
    '</rss>',
  ];
  return lines.join('\n');
}

// ── GitHub API helpers ──

function httpsRequest(url, opts, body, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: method || 'GET', ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildGitHubHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-scout-test',
  };
}

// ── Main ──

async function main() {
  const rootDir = path.resolve(__dirname, '..');

  // Load configs
  const auth = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'auth.json'), 'utf-8'));
  const pushConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'email-push-config.json'), 'utf-8'));
  const analysis = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'repo_analysis.json'), 'utf-8'));

  const token = auth.accessToken;
  const rssConfig = pushConfig.rss;
  const repos = (analysis.repos || []).slice(0, 10);

  if (!token) { console.error('No GitHub token'); process.exit(1); }
  if (!rssConfig || !rssConfig.repo) { console.error('No RSS config'); process.exit(1); }
  if (!repos.length) { console.error('No repos in analysis data'); process.exit(1); }

  const [owner, repoName] = rssConfig.repo.split('/');
  const branch = rssConfig.branch || 'main';
  const filePath = rssConfig.filePath || 'feeds/feed.xml';
  const commitMessage = rssConfig.commitMessage || 'Update RSS feed';

  console.log(`[RSS] 使用 ${repos.length} 个仓库生成 RSS...`);
  console.log(`[RSS] 目标: ${rssConfig.repo}/${branch}/${filePath}`);

  // Generate RSS XML
  const xml = buildGlobalRssXml(repos, rssConfig);
  console.log(`[RSS] XML 大小: ${xml.length} 字节\n`);
  console.log('[RSS] 前 800 字符:');
  console.log(xml.slice(0, 800));
  console.log('...\n');

  // Check if file already exists
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(filePath)}`;
  let sha = null;

  try {
    const getRes = await httpsRequest(
      `https://api.github.com${apiPath}?ref=${encodeURIComponent(branch)}`,
      { headers: buildGitHubHeaders(token) },
    );
    if (getRes.statusCode === 200) {
      const parsed = JSON.parse(getRes.data);
      sha = parsed.sha;
      console.log(`[RSS] 文件已存在 (SHA: ${sha.slice(0, 8)}), 将更新`);
    } else {
      console.log(`[RSS] 文件不存在, 将创建`);
    }
  } catch (e) {
    console.log(`[RSS] 检查文件状态: ${e.message}`);
  }

  // Upload
  const body = JSON.stringify({
    message: commitMessage,
    content: Buffer.from(xml, 'utf-8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });

  try {
    const putRes = await httpsRequest(
      `https://api.github.com${apiPath}`,
      { headers: { ...buildGitHubHeaders(token), 'Content-Type': 'application/json' } },
      body,
      'PUT',
    );

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      const publicUrl = rssConfig.publicUrl || `https://2538514844.github.io/feeds/feed.xml`;
      console.log(`\n[RSS] ✓ 上传成功! (HTTP ${putRes.statusCode})`);
      console.log(`[RSS] 公开地址: ${publicUrl}`);
      console.log(`[RSS] 请等待 GitHub Pages 部署 (约30秒-1分钟)`);
    } else {
      const parsed = JSON.parse(putRes.data || '{}');
      console.error(`\n[RSS] ✗ 上传失败: HTTP ${putRes.statusCode} — ${parsed.message}`);
    }
  } catch (e) {
    console.error(`\n[RSS] ✗ 上传异常: ${e.message}`);
  }
}

main().catch(console.error);
