const https = require('https');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const logEmitter = new EventEmitter();

function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { time: timestamp, message, level };
  logEmitter.emit('log', entry);
  return entry;
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

function clearAuth() {
  if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
}

// Detect API provider type from base URL
function getProvider(baseUrl) {
  const url = baseUrl.toLowerCase();
  if (url.includes('anthropic') || url.includes('claude')) return 'anthropic';
  return 'openai'; // Default: OpenAI-compatible (covers DeepSeek, SiliconFlow, Zhipu, etc.)
}

function readResponseText(res) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let data = '';
    res.on('data', (chunk) => {
      data += decoder.write(chunk);
    });
    res.on('end', () => {
      data += decoder.end();
      resolve(data);
    });
    res.on('error', reject);
  });
}

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: options.headers,
    }, async (res) => {
      try {
        const data = await readResponseText(res);
        resolve({ statusCode: res.statusCode, data });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', (e) => reject(e));
    if (options.timeout) {
      req.setTimeout(options.timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    }
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, async (res) => {
      try {
        const data = await readResponseText(res);
        resolve({ statusCode: res.statusCode, data });
      } catch (e) {
        reject(e);
      }
    }).on('error', reject);
  });
}

// --- GitHub Auth ---

// Device Flow (kept as fallback, uses a registered public client)
const GH_CLIENT_ID = 'Iv1.91ea47f8a3e1e68a';

async function handleStartGitHubLogin() {
  try {
    log('[GitHub] Starting device flow login...', 'info');
    const res = await httpsRequest('https://github.com/login/device/code', {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 15000,
    }, JSON.stringify({ client_id: GH_CLIENT_ID, scope: 'repo' }));
    const data = JSON.parse(res.data);
    if (res.statusCode === 200 && data.device_code) {
      log(`[GitHub] Device code received, user code: ${data.user_code}`, 'info');
      return {
        ok: true,
        verificationUri: data.verification_uri,
        userCode: data.user_code,
        deviceCode: data.device_code,
        interval: data.interval || 5,
      };
    }
    const errMsg = data.error || data.error_description || 'unknown';
    log(`[GitHub] Device flow failed: ${errMsg}`, 'error');
    return { ok: false, message: `Device Flow 不可用: ${errMsg}`, code: data.error };
  } catch (e) {
    log(`[GitHub] Device flow error: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

async function handlePollGitHubToken(deviceCode, interval) {
  const maxAttempts = 120;
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, interval * 1000));
    attempts++;

    try {
      const res = await httpsRequest('https://github.com/login/oauth/access_token', {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 15000,
      }, JSON.stringify({
        client_id: GH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }));
      const data = JSON.parse(res.data);

      if (data.access_token) {
        log('[GitHub] Token received via device flow!', 'success');
        return await handleTokenReceived(data.access_token);
      } else if (data.error === 'authorization_pending') {
        continue;
      } else if (data.error === 'slow_down') {
        interval += 5;
        continue;
      } else {
        log(`[GitHub] Poll error: ${data.error}`, 'error');
        return { ok: false, message: data.error_description || data.error };
      }
    } catch (e) {
      if (attempts >= maxAttempts) {
        log(`[GitHub] Poll timeout after ${attempts} attempts`, 'error');
        return { ok: false, message: '登录超时' };
      }
    }
  }
  return { ok: false, message: '登录超时' };
}

// PAT (Personal Access Token) login
async function handleLoginWithPat(token) {
  if (!token || !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    return { ok: false, message: '无效的 Token 格式。需要以 ghp_ 或 github_pat_ 开头' };
  }
  try {
    log('[GitHub] Validating PAT token...', 'info');
    const res = await httpsGet('https://api.github.com/user', {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'github-scout-app',
    });
    if (res.statusCode === 200) {
      let user;
      try {
        user = JSON.parse(res.data);
      } catch {
        log('[GitHub] PAT validation: response is not JSON', 'error');
        return { ok: false, message: 'GitHub 返回了非 JSON 响应，请检查网络或 Token 是否有效' };
      }
      if (!user.login) {
        return { ok: false, message: '无法获取用户信息，请检查 Token 权限' };
      }
      log(`[GitHub] PAT validated for user: ${user.login}`, 'success');
      const auth = {
        accessToken: token,
        login: user.login,
        avatar: user.avatar_url,
        name: user.name || user.login,
        method: 'pat',
      };
      saveAuth(auth);
      return { ok: true, auth };
    } else {
      let errMsg = `HTTP ${res.statusCode}`;
      try {
        const errData = JSON.parse(res.data);
        errMsg = errData.message || errMsg;
      } catch { /* not JSON */ }
      log(`[GitHub] PAT validation failed: ${errMsg}`, 'error');
      return { ok: false, message: errMsg };
    }
  } catch (e) {
    log(`[GitHub] PAT login error: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

async function handleTokenReceived(token) {
  try {
    const userRes = await httpsGet('https://api.github.com/user', {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'github-scout-app',
    });
    let user;
    try {
      user = JSON.parse(userRes.data);
    } catch {
      return { ok: false, message: 'GitHub 返回了非 JSON 响应' };
    }
    if (!user.login) {
      return { ok: false, message: '无法获取用户信息' };
    }
    const auth = {
      accessToken: token,
      login: user.login,
      avatar: user.avatar_url,
      name: user.name || user.login,
      method: 'device',
    };
    saveAuth(auth);
    return { ok: true, auth };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function handleGetAuthStatus() {
  const auth = loadAuth();
  if (auth) {
    return { loggedIn: true, user: { login: auth.login, avatar: auth.avatar, name: auth.name, method: auth.method } };
  }
  return { loggedIn: false };
}

function handleLogout() {
  clearAuth();
  log('[GitHub] Logged out', 'info');
  return { ok: true };
}

// --- GitHub API ---

function fetchGitHub(query, page = 1, token) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-scout-app',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${page}`;
    https.get(url, { headers }, async (res) => {
      try {
        const data = await readResponseText(res);
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    }).on('error', reject);
  });
}

async function handleFetchRepos(config = {}, mainWindow) {
  const auth = loadAuth();
  const token = auth?.accessToken;
  const status = token ? `已登录: ${auth.login}` : '未登录 (匿名模式, 60次/小时限流)';
  log(`[爬虫] 开始爬取... ${status}`, 'info');

  const now = new Date();
  const fc = config.filterConfig || {};

  // Date range
  let startDate, endDate;
  if (fc.startDate) {
    startDate = fc.startDate;
  } else {
    startDate = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  }
  if (fc.endDate) {
    endDate = fc.endDate;
  } else {
    endDate = now.toISOString().split('T')[0];
  }
  const dateRange = `${startDate}..${endDate}`;

  // Stars filter
  const minStars = fc.minStars ?? 5;
  const maxStars = fc.maxStars ? parseInt(fc.maxStars) : null;
  let starsFilter = `stars:>${minStars}`;
  if (maxStars !== null) starsFilter = `stars:${minStars}..${maxStars}`;

  // Forks filter
  const minForks = fc.minForks ? parseInt(fc.minForks) : null;
  const maxForks = fc.maxForks ? parseInt(fc.maxForks) : null;
  let forksPart = '';
  if (minForks !== null) forksPart += ` forks:>${minForks}`;
  if (maxForks !== null) forksPart += ` forks:<${maxForks}`;

  // Keywords (comma-separated)
  const keywords = (fc.keyword || '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);

  // Pages
  const maxPages = Math.min(fc.maxPages || 1, 10);

  const languages = ['JavaScript', 'Python', 'Rust', 'Go', 'TypeScript', 'Java', 'C++', 'C', 'C#', 'Swift', 'Kotlin', 'Shell'];
  const filters = [];

  if (keywords.length === 0) {
    // No keyword: search all
    const baseQ = `created:${dateRange} ${starsFilter}${forksPart}`.trim();
    filters.push({ q: baseQ, label: `All (${starsFilter}${maxStars ? `..${maxStars}` : ''}${forksPart})` });
    for (const lang of languages) {
      const q = `created:${dateRange} language:${lang} ${starsFilter}${forksPart}`.trim();
      filters.push({ q, label: lang });
    }
  } else {
    // Multiple keywords: search each keyword
    for (const kw of keywords) {
      const baseQ = `${kw} created:${dateRange} ${starsFilter}${forksPart}`.trim();
      filters.push({ q: baseQ, label: `All: ${kw}` });
      for (const lang of languages) {
        const q = `${kw} created:${dateRange} language:${lang} ${starsFilter}${forksPart}`.trim();
        filters.push({ q, label: `${lang}: ${kw}` });
      }
    }
  }

  // Star range filters (only when no keywords and no custom star range)
  if (keywords.length === 0 && !fc.minStars && !fc.maxStars) {
    filters.push({ q: `created:${dateRange} stars:10..100`, label: 'Stars 10-100' });
    filters.push({ q: `created:${dateRange} stars:100..500`, label: 'Stars 100-500' });
    filters.push({ q: `created:${dateRange} stars:>500`, label: 'Stars >500' });
  }

  const allMap = new Map();

  for (let i = 0; i < filters.length; i++) {
    const { q, label } = filters[i];
    log(`[爬虫] [${i + 1}/${filters.length}] ${label}...`, 'info');

    for (let page = 1; page <= maxPages; page++) {
      try {
        const data = await fetchGitHub(q, page, token);
        const count = data.items?.length || 0;
        let newCount = 0;
        for (const item of (data.items || [])) {
          if (!allMap.has(item.full_name)) {
            allMap.set(item.full_name, {
              name: item.full_name,
              stars: item.stargazers_count,
              created: item.created_at.substring(0, 10),
              description: item.description || 'No description',
              language: item.language || 'N/A',
              url: item.html_url,
              forks: item.forks_count,
              open_issues: item.open_issues_count,
            });
            newCount++;
          }
        }
        if (maxPages > 1) {
          log(`[爬虫]   ✓ 第${page}页: ${count} 条结果, +${newCount} 新仓库 (累计 ${allMap.size})`, 'success');
        } else {
          log(`[爬虫]   ✓ ${count} 条结果, +${newCount} 新仓库 (累计 ${allMap.size})`, 'success');
        }
      } catch (e) {
        log(`[爬虫]   ✗ ${e.message}`, 'error');
      }

      if (page < maxPages && i < filters.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    if (i < filters.length - 1 && maxPages === 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const repos = Array.from(allMap.values()).sort((a, b) => b.stars - a.stars);
  log(`[爬虫] 完成! 共 ${repos.length} 个唯一仓库`, 'success');
  return { repos, total: repos.length };
}

// --- AI API ---

async function handleTestConnection(aiConfig) {
  const { baseUrl, apiKey, model } = aiConfig;
  const provider = getProvider(baseUrl);
  const cleanBase = baseUrl.replace(/\/+$/, '');

  try {
    if (provider === 'anthropic') {
      const url = `${cleanBase}/v1/messages`;
      const body = JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK' }],
      });
      const res = await httpsRequest(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: 15000,
      }, body);
      const parsed = JSON.parse(res.data);
      if (res.statusCode === 200) {
        return { ok: true, message: 'Connection successful!', model: parsed.model || model };
      }
      return { ok: false, message: parsed.error?.message || `HTTP ${res.statusCode}` };
    } else {
      const url = `${cleanBase}/v1/chat/completions`;
      const body = JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
        max_tokens: 10,
      });
      const res = await httpsRequest(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 15000,
      }, body);
      const parsed = JSON.parse(res.data);
      if (res.statusCode === 200) {
        return { ok: true, message: 'Connection successful!', model: parsed.model || model };
      }
      return { ok: false, message: parsed.error?.message || `HTTP ${res.statusCode}` };
    }
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// --- Repo Analysis Data Persistence ---

const REPO_ANALYSIS_FILE = path.join(DATA_DIR, 'repo_analysis.json');

function sanitizeText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeTag(tag) {
  return sanitizeText(tag)
    .replace(/[，、；：]/g, '')
    .replace(/["'`“”‘’()\[\]{}\\/<>]/g, '')
    .trim();
}

function sanitizeRepoAnalysisData(data) {
  const repoMap = new Map();

  for (const repo of (data?.repos || [])) {
    const name = sanitizeText(repo.name);
    const url = sanitizeText(repo.url);
    if (!name || !url) continue;

    const tags = [...new Set((repo.tags || []).map(sanitizeTag).filter(Boolean))];
    const description = sanitizeText(repo.description) || 'GitHub开源项目';

    repoMap.set(name, {
      ...repo,
      name,
      url,
      tags,
      description,
      updated: sanitizeText(repo.updated),
    });
  }

  return { repos: Array.from(repoMap.values()) };
}

function loadRepoAnalysis() {
  try {
    const data = JSON.parse(fs.readFileSync(REPO_ANALYSIS_FILE, 'utf-8'));
    return sanitizeRepoAnalysisData(data);
  } catch {
    return { repos: [] };
  }
}

function saveRepoAnalysis(data) {
  fs.writeFileSync(REPO_ANALYSIS_FILE, JSON.stringify(sanitizeRepoAnalysisData(data), null, 2));
}

// Normalize tag: lowercase, trim, unify common variants
function normalizeTag(tag) {
  const t = tag.trim();
  const lower = t.toLowerCase();
  // Build existing tag map from saved data
  const saved = loadRepoAnalysis();
  const existingTags = new Set();
  saved.repos.forEach(r => (r.tags || []).forEach(tag => existingTags.add(tag)));
  // Case-insensitive match against existing tags
  for (const existing of existingTags) {
    if (existing.toLowerCase() === lower) return existing;
  }
  return t;
}

// Auto-analyze repo from metadata (no AI call)
function autoAnalyzeRepo(repo) {
  const tags = [];
  const name = (repo.name || '').toLowerCase();

  // Language tag
  if (repo.language && repo.language !== 'N/A' && repo.language !== 'null') {
    tags.push(repo.language);
  }

  // Name-based tech keywords
  const techKeywords = {
    'react': 'React', 'vue': 'Vue', 'angular': 'Angular', 'svelte': 'Svelte',
    'next': 'Next.js', 'nuxt': 'Nuxt',
    'node': 'Node.js', 'python': 'Python', 'golang': 'Go', 'go-': 'Go',
    'rust': 'Rust', 'typescript': 'TypeScript',
    'docker': 'Docker', 'kube': 'K8s', 'k8s': 'K8s',
    'llm': 'LLM', 'ai': 'AI', 'ml': '机器学习', 'chat': '聊天',
    'api': 'API', 'cli': 'CLI', 'sdk': 'SDK', 'bot': '机器人',
    'framework': '框架', 'lib': '库', 'tool': '工具', 'generator': '生成器',
    'awesome': '资源集合', 'tutorial': '教程', 'demo': '示例',
    'web': 'Web', 'server': '服务器', 'database': '数据库',
    'ui': 'UI', 'theme': '主题', 'plugin': '插件', 'extension': '扩展',
    'game': '游戏', 'engine': '引擎',
    'crypto': '加密', 'security': '安全', 'auth': '认证',
    'template': '模板', 'boilerplate': '脚手架',
    'monitor': '监控', 'proxy': '代理', 'crawler': '爬虫',
    'automation': '自动化', 'deploy': '部署',
  };
  for (const [keyword, tag] of Object.entries(techKeywords)) {
    if (name.includes(keyword)) tags.push(tag);
  }

  // Description-based keywords
  if (repo.description && repo.description !== 'No description') {
    const desc = repo.description.toLowerCase();
    for (const [keyword, tag] of Object.entries(techKeywords)) {
      if (desc.includes(keyword) && !tags.includes(tag)) tags.push(tag);
    }
  }

  if (repo.stars >= 10000) tags.push('热门');

  // Generate description
  let description = '';
  if (repo.description && repo.description !== 'No description') {
    description = repo.description;
  } else if (tags.length > 0) {
    description = `${tags.join(' / ')}相关项目`;
  } else {
    description = 'GitHub开源项目';
  }

  return {
    tags: tags.length > 0 ? [...new Set(tags)].slice(0, 3) : ['工具'],
    description,
  };
}

// Find similar repos from saved data by matching any tag
function findSimilarRepos(repos, savedRepos, tagMap) {
  const results = [];
  for (const repo of repos) {
    const tags = tagMap[repo.name]?.tags || [];
    const similar = savedRepos.filter(sr =>
      sr.tags && sr.tags.some(st => tags.some(t => t.toLowerCase() === st.toLowerCase()))
    ).slice(0, 5);
    results.push({ repo, similar });
  }
  return results;
}

// --- AI Analysis ---

async function handleAnalyzeWithAI(aiConfig, repos, mainWindow) {
  const { baseUrl, apiKey, model, systemPrompt } = aiConfig;
  const provider = getProvider(baseUrl);
  const cleanBase = baseUrl.replace(/\/+$/, '');

  log('[AI] 准备分析数据...', 'info');

  // Call AI API
  async function callAI(messages, timeout, maxTokens) {
    // Strip invisible/control characters from user content before sending
    const cleanMessages = messages.map(m => ({
      ...m,
      content: m.content.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''),
    }));

    if (provider === 'anthropic') {
      const url = `${cleanBase}/v1/messages`;
      const body = JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        system: cleanMessages.find(m => m.role === 'system')?.content || '',
        max_tokens: maxTokens || 4096,
        messages: cleanMessages.filter(m => m.role !== 'system'),
        temperature: 0.7,
      });
      const res = await httpsRequest(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        timeout: timeout || 60000,
      }, body);
      const parsed = JSON.parse(res.data);
      if (res.statusCode === 200) {
        const raw = parsed.content?.[0]?.text || 'No response';
        const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        return { ok: true, content: cleaned, model: parsed.model || model };
      }
      return { ok: false, message: parsed.error?.message || `HTTP ${res.statusCode}` };
    } else {
      const url = `${cleanBase}/v1/chat/completions`;
      const body = JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: cleanMessages,
        max_tokens: maxTokens || 4096,
        temperature: 0.7,
      });
      const res = await httpsRequest(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: timeout || 60000,
      }, body);
      const parsed = JSON.parse(res.data);
      if (res.statusCode === 200) {
        const raw = parsed.choices?.[0]?.message?.content || 'No response';
        const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        return { ok: true, content: cleaned, model: parsed.model || model };
      }
      return { ok: false, message: parsed.error?.message || `HTTP ${res.statusCode}` };
    }
  }

  // Parse tag analysis response: "name|tag1,tag2|description" per line
  function parseTagAnalysis(content) {
    const tagMap = {};
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        const name = parts[0].trim();
        const tags = parts[1].split(',').map(t => t.trim()).filter(t => t);
        const description = parts.slice(2).join('|').trim();
        if (name && tags.length > 0) {
          tagMap[name] = { tags, description };
        }
      }
    }
    return tagMap;
  }

  // Compute top N tags from repo list
  function computeTopTags(repoList, n = 5) {
    const counts = {};
    repoList.forEach(r => (r.tags || []).forEach(t => {
      const key = t.toLowerCase();
      counts[key] = (counts[key] || { count: 0, original: t });
      counts[key].count++;
    }));
    return Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, n)
      .map(t => t.original);
  }

  try {
    // ===== 模块一：标签分析（全部AI批量分析） =====
    log(`[AI] 正在为 ${repos.length} 个仓库生成标签...`, 'info');

    const tagAnalysisPrompt = `你是一个GitHub项目分析专家。请分析以下仓库，对每个仓库：
1. 生成1-3个标签（技术领域/用途/特点）
2. 用一句话描述它的核心内容

重要规则：
- 【不要误判】如果仓库有 Forks（Forks > 0），说明有其他开发者在使用，这是一个有意义的信号，请不要标记为"无意义"——即使描述为空也要根据名称关键词推断用途
- 只有同时满足以下条件时才标记为"无意义"：仓库名形如"随机用户名/star-十六进制"（如 SomeRandomUser/star-4833d8），或名称是明显随机拼接的单词，且 Forks 为 0
- 对于正常仓库，即使描述为空，也请根据名称中的技术关键词（如 react、vue、compiler、engine 等）推断用途

标签规范化（必须遵守）：
- 语言标签统一使用标准名称：JavaScript/TypeScript/Python/Java/Go/C++/C#/Rust/Ruby/Swift/Kotlin/Shell/PHP/C/R
- 框架/库标签统一：React/Vue/Angular/Svelte/Next.js/Nuxt/Node.js/Express/Django/Flask/FastAPI/Spring/.NET
- 不要使用变体或缩写（如不要写 JS/Javascript/JSX，统一写 JavaScript）
- 用途标签统一：UI框架/后端/前端/数据库/DevOps/CLI工具/API/机器学习/数据可视化/游戏/自动化/安全
- 同类标签必须合并，不要拆分（如 "AI" 和 "人工智能" 统一写 "AI"，"ML" 和 "机器学习" 统一写 "机器学习"）

输出约束（必须严格遵守）：
- 每个仓库只输出一行，不要输出标题、解释、备注、代码块或额外说明
- 每行严格使用半角竖线 "|" 作为分隔符，严格使用半角逗号 "," 分隔多个标签
- 标签只能包含中文、英文字母、数字，以及 "+"、"#"、"."、"-"，不要包含 emoji、引号、括号、斜杠、反斜杠、冒号、分号、星号或任何不可见字符
- 标签不要带序号、项目符号或前后空格，不要使用全角标点
- 如果不确定，请优先使用上面列出的标准标签，不要自造奇怪标签

格式要求：每个仓库一行，格式为：仓库名|标签1,标签2,标签3|一句话描述
例如：facebook/react|JavaScript,UI框架,前端|React是一个用于构建用户界面的声明式JavaScript库
例如：SomeRandomUser/star-4833d8|无意义|该仓库无意义

请简洁回答，使用中文。`;

    // Batch AI: all repos, 50 per batch, sent in parallel
    const batchSize = 50;
    const batchPromises = [];

    for (let i = 0; i < repos.length; i += batchSize) {
      const batchStart = i;
      const batch = repos.slice(i, i + batchSize);
      const batchText = batch.map(r => {
        const desc = (r.description && r.description !== 'No description') ? r.description : '无描述';
        return `${r.name} | 语言:${r.language} | Stars:${r.stars} | Forks:${r.forks} | 描述:${desc}`;
      }).join('\n');

      batchPromises.push(
        callAI([
          { role: 'system', content: tagAnalysisPrompt },
          { role: 'user', content: batchText },
        ], 60000, 4096).then(result => ({ index: batchStart, result }))
      );
    }

    // Wait for all batches to complete
    const results = await Promise.allSettled(batchPromises);
    const tagMap = {};

    for (const entry of results) {
      if (entry.status === 'fulfilled') {
        const { index, result } = entry.value;
        if (result.ok) {
          const batchMap = parseTagAnalysis(result.content);
          Object.assign(tagMap, batchMap);
          log(`[AI] 批次 ${Math.floor(index / batchSize) + 1}: 解析 ${Object.keys(batchMap).length} 个`, 'success');
        } else {
          log(`[AI] 批次 ${Math.floor(index / batchSize) + 1} 失败: ${result.message}`, 'error');
        }
      } else {
        log(`[AI] 批次异常: ${entry.reason}`, 'error');
      }
    }

    // Ensure ALL repos have an entry, and flag obvious spam repos
    for (const repo of repos) {
      if (!tagMap[repo.name]) {
        const auto = autoAnalyzeRepo(repo);
        tagMap[repo.name] = auto;
      }
      // Deterministic spam detection: "star-xxxxxx" pattern + 0 forks + no language
      const nameParts = repo.name.split('/');
      const projectName = nameParts[1] || '';
      if (projectName.match(/^star-[0-9a-f]{5,}$/i) && repo.forks === 0 && repo.language === 'N/A') {
        tagMap[repo.name] = { tags: ['无意义'], description: '该仓库无意义' };
      }
    }

    // Post-process: normalize tag variants across all results
    const tagAliasMap = {
      // Language aliases
      'js': 'JavaScript', 'javascript': 'JavaScript', 'jsx': 'JavaScript',
      'ts': 'TypeScript', 'typescript': 'TypeScript', 'tsx': 'TypeScript',
      'py': 'Python', 'python': 'Python',
      'golang': 'Go', 'go语言': 'Go', 'go': 'Go',
      'java': 'Java', 'c++': 'C++', 'c语言': 'C', 'c#': 'C#', 'csharp': 'C#',
      'ruby': 'Ruby', 'rust': 'Rust', 'php': 'PHP',
      'swift': 'Swift', 'kotlin': 'Kotlin', 'shell': 'Shell', 'bash': 'Shell',
      'lua': 'Lua', 'scala': 'Scala',
      // Framework aliases
      'react': 'React', 'react.js': 'React', 'reactjs': 'React',
      'vue': 'Vue', 'vue.js': 'Vue', 'vuejs': 'Vue', 'vue3': 'Vue',
      'angular': 'Angular', 'angular.js': 'Angular',
      'svelte': 'Svelte',
      'node': 'Node.js', 'node.js': 'Node.js', 'nodejs': 'Node.js', 'node后端': 'Node.js',
      'express': 'Express', 'express.js': 'Express',
      'django': 'Django', 'flask': 'Flask', 'fastapi': 'FastAPI',
      'spring': 'Spring', 'spring boot': 'Spring Boot',
      'next': 'Next.js', 'next.js': 'Next.js', 'nextjs': 'Next.js',
      'nuxt': 'Nuxt', 'nuxt.js': 'Nuxt',
      // AI/ML aliases
      'ai': 'AI', '人工智能': 'AI', '人工智慧': 'AI', 'aigc': 'AI',
      'ml': '机器学习', '机器学习': '机器学习', 'machine learning': '机器学习',
      'llm': '大模型', '大模型': '大模型', '大语言模型': '大模型', 'llm模型': '大模型',
      'nlp': 'NLP', '自然语言处理': 'NLP',
      'cv': '计算机视觉', '计算机视觉': '计算机视觉', '图像识别': '计算机视觉',
      '深度学习': '深度学习', 'deep learning': '深度学习', 'neural': '深度学习',
      'rnn': 'RNN', 'cnn': 'CNN', 'transformer': 'Transformer',
      // Tool/utility aliases
      '工具': '工具', 'utility': '工具', 'utils': '工具', 'tool': '工具', 'tools': '工具',
      'cli': 'CLI', '命令行': 'CLI', '终端': 'CLI',
      'api': 'API', '接口': 'API', 'rest': 'API', 'graphql': 'GraphQL',
      'ui': 'UI', 'ui框架': 'UI框架', '界面': 'UI', '组件库': 'UI组件库',
      '前端': '前端', 'frontend': '前端', 'web前端': '前端',
      '后端': '后端', 'backend': '后端', '服务器': '后端', '服务端': '后端',
      '数据库': '数据库', 'database': '数据库', 'db': '数据库',
      'devops': 'DevOps', '运维': 'DevOps', 'ci/cd': 'DevOps',
      '安全': '安全', 'security': '安全', 'auth': '认证', '认证': '认证', '权限': '认证',
      '游戏': '游戏', 'game': '游戏', 'gaming': '游戏',
      '爬虫': '爬虫', 'crawler': '爬虫', 'scraper': '爬虫',
      '自动化': '自动化', 'automation': '自动化',
      '数据': '数据处理', '数据处理': '数据处理', '数据可视化': '数据可视化', '可视化': '数据可视化', 'data': '数据处理',
      '开源': '开源', 'awesome': '资源集合', '资源': '资源集合', '集合': '资源集合',
      '教程': '教程', 'tutorial': '教程', '学习': '教程', '指南': '教程',
      '示例': '示例', 'demo': '示例', '例子': '示例', 'sample': '示例',
      '模板': '模板', 'template': '模板', '脚手架': '脚手架', 'boilerplate': '脚手架', 'starter': '脚手架',
      '部署': '部署', 'deploy': '部署', 'deployment': '部署',
      '监控': '监控', 'monitor': '监控', 'monitoring': '监控', '日志': '监控',
      '代理': '代理', 'proxy': '代理',
      'docker': 'Docker', '容器': 'Docker', 'container': 'Docker', 'k8s': 'K8s', 'kubernetes': 'K8s',
      'web': 'Web', '网站': 'Web', '网页': 'Web',
      '移动端': '移动端', '移动': '移动端', 'mobile': '移动端', 'ios': 'iOS', 'android': 'Android',
      '框架': '框架', 'framework': '框架',
      '库': '库', 'library': '库', 'lib': '库',
      '插件': '插件', 'plugin': '插件', 'extension': '扩展', '扩展': '扩展',
      '引擎': '引擎', 'engine': '引擎',
      '编译器': '编译器', 'compiler': '编译器',
      '加密': '加密', 'crypto': '加密', '区块链': '区块链', 'blockchain': '区块链',
      '测试': '测试', 'testing': '测试', '单元测试': '测试',
      '机器人': '机器人', 'bot': '机器人', '机器人助手': '机器人',
      '聊天': '聊天', 'chat': '聊天', 'im': '聊天',
      'sdk': 'SDK', '开发工具包': 'SDK',
    };

    for (const repo of repos) {
      const analysis = tagMap[repo.name];
      if (!analysis || !analysis.tags) continue;
      analysis.tags = [...new Set(analysis.tags.map(t => tagAliasMap[t.toLowerCase()] || t))];
    }

    log(`[AI] 标签分析完成，共 ${Object.keys(tagMap).length} 个仓库`, 'success');

    // ===== 模块二：补充无描述/无意义仓库 =====
    const saved = loadRepoAnalysis();
    const meaninglessRepos = repos.filter(r => {
      const t = tagMap[r.name];
      if (!t) return true;
      const hasMeaninglessTag = t.tags && t.tags.some(tag => tag === '无意义');
      const isEmptyDesc = !t.description || t.description.trim() === '' || t.description === '该仓库无意义';
      return hasMeaninglessTag || isEmptyDesc;
    });

    if (meaninglessRepos.length > 0 && saved.repos.length > 0) {
      log(`[AI] 发现 ${meaninglessRepos.length} 个需补充仓库，正在从历史数据中查找参考...`, 'info');

      // Content-based similarity: match by owner or project name prefix
      const findRefRepos = (repo, savedRepos) => {
        const parts = repo.name.split('/');
        const owner = parts[0] || '';
        const projectName = parts[1] || '';
        return savedRepos.filter(sr => {
          const srParts = sr.name.split('/');
          return (owner && srParts[0] === owner)
            || (projectName && srParts[1] && (
                srParts[1].includes(projectName.substring(0, 5))
                || projectName.includes(srParts[1].substring(0, 5))
              ));
        }).slice(0, 5);
      };

      const refEntries = [];
      for (const repo of meaninglessRepos) {
        const similar = findRefRepos(repo, saved.repos);
        if (similar.length > 0) {
          const desc = (repo.description && repo.description !== 'No description') ? repo.description : '无描述';
          refEntries.push(
            `仓库: ${repo.name} | 语言:${repo.language} | Stars:${repo.stars} | 描述:${desc}\n`
            + `参考:\n${similar.map(s => `- ${s.name}: Tags:${(s.tags||[]).join(',')} | ${s.description}`).join('\n')}`
          );
        }
      }

      if (refEntries.length > 0) {
        const descSupplementPrompt = `以下是几个信息不足的GitHub仓库，以及可能相关的历史仓库描述作为参考。请为每个仓库提供1-3个标签和一句话描述。

格式：仓库名|标签1,标签2|一句话描述

判断规则：
- 如果仓库有 Forks（Forks > 0），说明有实际用户在用，请不要标记为"无意义"，根据名称关键词推断用途
- 只有仓库名形如"随机用户名/star-十六进制"且 Forks 为 0 时，才标记为"无意义"
- 请根据名称中的技术关键词和历史参考信息进行推断

标签规范化：
- 语言统一：JavaScript/TypeScript/Python/Go/Rust/Java/C++/C#/Swift/Kotlin 等标准名称
- AI/人工智能统一写 AI，ML/机器学习统一写 机器学习，LLM/大语言模型统一写 大模型
- 同类标签必须合并，不要拆分（如 "UI框架" 和 "前端框架" 统一写 "UI框架"）

输出约束（必须严格遵守）：
- 每个仓库只输出一行，不要输出标题、解释、备注、代码块或额外说明
- 每行严格使用半角竖线 "|" 作为分隔符，严格使用半角逗号 "," 分隔多个标签
- 标签只能包含中文、英文字母、数字，以及 "+"、"#"、"."、"-"，不要包含 emoji、引号、括号、斜杠、反斜杠、冒号、分号、星号或任何不可见字符
- 标签不要带序号、项目符号或前后空格，不要使用全角标点
- 如果不确定，请优先使用标准标签，不要自造奇怪标签

请简洁回答，使用中文。`;

        const descResult = await callAI([
          { role: 'system', content: descSupplementPrompt },
          { role: 'user', content: refEntries.join('\n\n') },
        ], 60000);

        if (descResult.ok) {
          const supplementMap = parseTagAnalysis(descResult.content);
          let updated = 0;
          for (const [name, data] of Object.entries(supplementMap)) {
            if (tagMap[name]) { tagMap[name] = data; updated++; }
          }
          log(`[AI] 补充描述完成，更新了 ${updated} 个仓库`, 'success');
        }
      } else {
        log(`[AI] 未找到历史参考，跳过补充`, 'info');
      }
    }

    // ===== 合并保存 =====
    log('[AI] 正在合并保存数据...', 'info');

    const existingMap = new Map();
    saved.repos.forEach(r => existingMap.set(r.name, r));

    // Build existing tag set once for normalization (avoid per-call disk reads)
    const existingTagSet = new Set();
    saved.repos.forEach(r => (r.tags || []).forEach(t => existingTagSet.add(t)));

    const today = new Date().toISOString().split('T')[0];
    const mergedRepos = [];

    for (const repo of repos) {
      const analysis = tagMap[repo.name];
      if (!analysis) continue;

      const isMeaningless = analysis.tags.some(t => t.toLowerCase() === '无意义');
      if (isMeaningless) continue; // 不保存无意义标签的仓库

      // Inline normalizeTag: case-insensitive match against existing tags
      const normalizedTags = analysis.tags.map(t => {
        const lower = t.toLowerCase();
        for (const existing of existingTagSet) {
          if (existing.toLowerCase() === lower) return existing;
        }
        return t;
      });
      const merged = {
        name: repo.name,
        url: repo.url,
        tags: normalizedTags,
        description: analysis.description,
        stars: repo.stars,
        forks: repo.forks,
        updated: today,
      };

      // If existing repo with same name, keep the newer one
      const existing = existingMap.get(repo.name);
      if (existing) {
        existingMap.delete(repo.name); // Remove from existing so we don't double-add
        // Merge: keep newer data but preserve tags from both
        const allTags = [...new Set([...merged.tags, ...existing.tags])];
        merged.tags = allTags;
        if (repo.created > (existing.updated || '')) {
          merged.updated = today;
        }
      }

      mergedRepos.push(merged);
    }

    // Add remaining existing repos (not updated in this batch)
    existingMap.forEach(r => mergedRepos.push(r));

    const finalData = { repos: mergedRepos };
    saveRepoAnalysis(finalData);
    log(`[AI] 已保存 ${mergedRepos.length} 个仓库的分析数据`, 'success');

    // ===== 模块三：总结（当前批次 + 跨期趋势，并发发送） =====
    log('[AI] 正在生成总结...', 'info');

    const currentSummaryPrompt = `你是一个GitHub趋势分析专家。以下是本次爬取的全部仓库数据（含标签、描述、stars、forks、更新时间）。

请从以下角度总结：
## 标签分布趋势
- 出现频率最高的热门标签
- 主要技术领域占比

## 语言分布
- 各语言占比和特点

## 最有潜力项目
- 综合推荐前5个并说明理由

## 整体趋势判断
- 新兴方向和值得关注的点

请简洁回答，使用中文。`;

    const validRepos = mergedRepos.filter(r => r.updated === today);
    const currentText = validRepos.map(r =>
      `${r.name} | Tags:${r.tags.join(',')} | 语言:${repos.find(rp => rp.name === r.name)?.language || 'N/A'} | Stars:${r.stars} | Forks:${r.forks} | Updated:${r.updated} | Desc:${r.description}`
    ).join('\n');

    const langStats = {};
    repos.forEach(r => { langStats[r.language] = (langStats[r.language] || 0) + 1; });
    const langSummary = Object.entries(langStats).sort((a, b) => b[1] - a[1]).map(([lang, count]) => `${lang}: ${count}`).join(', ');

    // Build per-repo analysis output
    let fullContent = '## 仓库分析\n\n';
    for (const repo of repos) {
      const analysis = tagMap[repo.name];
      if (!analysis) continue;
      const isMeaningless = analysis.tags.some(t => t.toLowerCase() === '无意义');
      if (isMeaningless) continue;

      fullContent += `### ${repo.name}\n`;
      fullContent += `**标签：** ${analysis.tags.join(', ')}\n`;
      fullContent += `${analysis.description}\n`;
      fullContent += `> Stars: ${repo.stars} | Forks: ${repo.forks} | 语言: ${repo.language} | [${repo.url}](${repo.url})\n\n`;
    }

    // Prepare both AI calls
    const summaryPromises = [];

    // Call 1: Current batch summary
    summaryPromises.push(
      callAI([
        { role: 'system', content: systemPrompt || currentSummaryPrompt },
        { role: 'user', content: `仓库总数: ${validRepos.length}\n语言分布: ${langSummary}\n\n仓库数据:\n${currentText}` },
      ], 60000).then(result => ({ type: 'current', result }))
    );

    // Call 2: Cross-period trend summary
    const topTags = computeTopTags(validRepos, 5);
    if (topTags.length > 0) {
      const matchedHistorical = saved.repos.filter(r =>
        r.tags && r.tags.some(t => topTags.some(tt => t.toLowerCase() === tt.toLowerCase()))
      );

      if (matchedHistorical.length > 0) {
        log(`[AI] 热门标签: ${topTags.join(', ')}, 找到 ${matchedHistorical.length} 个历史匹配仓库`, 'info');

        const trendSummaryPrompt = `你是一个GitHub趋势分析专家。以下包含两部分数据：

【当前批次】本次爬取的仓库（含标签、描述、stars、forks、更新时间）
【历史匹配】从历史数据中找到的、与当前热门标签匹配的旧仓库

热门标签：${topTags.join(', ')}

请从以下角度总结：
## 趋势对比
- 当前批次与历史仓库在相同领域的变化
- 哪些方向热度上升/下降

## 时间线分析
- 按更新时间排序，观察项目演进趋势

## 跨期最有潜力项目
- 综合当前和历史数据，推荐最值得关注的5个项目

## 整体趋势判断
- 基于时间跨度的新兴方向预测

请简洁回答，使用中文。`;

        const trendText = `【当前批次】\n${currentText}\n\n【历史匹配仓库】\n` +
          matchedHistorical.map(r =>
            `${r.name} | Tags:${r.tags.join(',')} | Stars:${r.stars} | Forks:${r.forks} | Updated:${r.updated} | Desc:${r.description}`
          ).join('\n');

        summaryPromises.push(
          callAI([
            { role: 'system', content: trendSummaryPrompt },
            { role: 'user', content: trendText },
          ], 120000).then(result => ({ type: 'trend', result }))
        );
      }
    }

    // Wait for all summary calls in parallel
    log(`[AI] 同时发送 ${summaryPromises.length} 个总结请求...`, 'info');
    const summaryResults = await Promise.allSettled(summaryPromises);

    let currentSummary = null;
    for (const entry of summaryResults) {
      if (entry.status === 'fulfilled') {
        const { type, result } = entry.value;
        if (type === 'current') {
          currentSummary = result;
          if (result.ok) {
            fullContent += '---\n\n' + result.content;
          } else {
            fullContent += '---\n\n当前批次总结生成失败: ' + result.message;
          }
        } else if (type === 'trend') {
          if (result.ok) {
            fullContent += '\n\n--- 历史趋势对比 ---\n\n' + result.content;
            log('[AI] 跨期趋势对比完成', 'success');
          } else {
            log(`[AI] 趋势对比失败: ${result.message}`, 'error');
          }
        }
      }
    }

    if (!currentSummary || !currentSummary.ok) {
      log(`[AI] 总结失败: ${currentSummary?.message || '未知错误'}`, 'error');
      return { ok: false, message: `总结失败: ${currentSummary?.message || '未知错误'}` };
    }

    log('[AI] 分析完成!', 'success');
    const repoUrlMap = repos.reduce((m, r) => { m[r.name] = r.url; return m; }, {});
    const repoTags = repos.reduce((m, r) => {
      const t = tagMap[r.name];
      if (t) m[r.name] = { tags: t.tags, description: t.description };
      return m;
    }, {});
    return { ok: true, content: fullContent, model: currentSummary.model, repoUrlMap, repoTags };
  } catch (e) {
    log(`[AI] 请求失败: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

function handleSaveAiConfig(config) {
  try {
    saveSettings(config);
    log(`[配置] 已保存到 ${SETTINGS_FILE}`, 'success');
    return { ok: true };
  } catch (e) {
    log(`[配置] 保存失败: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

function handleLoadAiConfig() {
  return loadSettings();
}

module.exports = {
  handleFetchRepos, handleAnalyzeWithAI, handleTestConnection,
  loadSettings, saveSettings,
  handleStartGitHubLogin, handlePollGitHubToken, handleLoginWithPat, handleGetAuthStatus, handleLogout,
  handleSaveAiConfig, handleLoadAiConfig,
  logEmitter, log,
};
