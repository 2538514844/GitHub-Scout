const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { injectLocalImageRuntimeStyle } = require('./local-image-runtime');
const { synthesizeTtsToCache, loadPresentationConfig } = require('./presentation');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'final_prompt.txt');
const README_CAROUSEL_RUNS_DIR = path.join(DATA_DIR, 'readme-carousel-runs');
const README_PIPELINE_CONCURRENCY = 3;
const PAGE_TURN_SOUND_FILE_NAME = 'mixkit-fast-double-click-on-mouse-275.wav';
const PAGE_TURN_SOUND_SOURCE_PATH = path.join(__dirname, '..', PAGE_TURN_SOUND_FILE_NAME);
const HTML_FONT_FILE_NAME = 'htmlFont.ttf';
const HTML_FONT_SOURCE_PATH = path.join(DATA_DIR, 'fonts', HTML_FONT_FILE_NAME);
const SOURCE_APP_FONT_STACK = "'Google Sans', 'Roboto', 'Noto Sans SC', 'htmlFont', system-ui, -apple-system, sans-serif";
const SOURCE_APP_FONT_LINKS = `
  <link id="repo-google-fonts-preconnect" rel="preconnect" href="https://fonts.googleapis.com" />
  <link id="repo-google-fonts-gstatic-preconnect" rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link id="repo-google-fonts-stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@300;400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet" />`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(README_CAROUSEL_RUNS_DIR)) fs.mkdirSync(README_CAROUSEL_RUNS_DIR, { recursive: true });

const logEmitter = new EventEmitter();

const LOGS_DIR = path.join(DATA_DIR, 'logs');
let currentLogDate = '';

function getLogFilePath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `app-${today}.log`);
}

function ensureLogFile() {
  const today = new Date().toISOString().slice(0, 10);
  if (currentLogDate === today) return;
  ensureDir(LOGS_DIR);
  currentLogDate = today;
}

function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { time: timestamp, message, level };
  logEmitter.emit('log', entry);

  try {
    ensureLogFile();
    const logPath = getLogFilePath();
    const line = JSON.stringify({ time: new Date().toISOString(), message, level }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (e) {
    // 写日志文件失败不应该影响应用运行
  }

  return entry;
}

const PROMPTS_OVERRIDE_FILE = path.join(DATA_DIR, 'prompts.json');
const PROMPTS_HISTORY_FILE = path.join(DATA_DIR, 'prompts-history.json');

let promptOverrides = {};
try {
  if (fs.existsSync(PROMPTS_OVERRIDE_FILE)) {
    promptOverrides = JSON.parse(fs.readFileSync(PROMPTS_OVERRIDE_FILE, 'utf-8')) || {};
  }
} catch { /* ignore corrupt overrides */ }

let promptHistory = {};
try {
  if (fs.existsSync(PROMPTS_HISTORY_FILE)) {
    promptHistory = JSON.parse(fs.readFileSync(PROMPTS_HISTORY_FILE, 'utf-8')) || {};
  }
} catch { /* ignore corrupt history */ }

function savePromptHistory() {
  fs.writeFileSync(PROMPTS_HISTORY_FILE, JSON.stringify(promptHistory, null, 2));
}

function savePromptOverrides() {
  fs.writeFileSync(PROMPTS_OVERRIDE_FILE, JSON.stringify(promptOverrides, null, 2));
}

function resolvePrompt(key, defaultValue) {
  if (promptOverrides[key] && String(promptOverrides[key]).trim()) {
    return String(promptOverrides[key]).trim();
  }
  return String(defaultValue || '').trim();
}

function getPromptRegistry() {
  const readmeHtmlOutputWrapperDefault = `### 输出包裹规则（强制）
* 最终完整 HTML 必须放在一个三单引号代码块中。
* 优先使用以下格式：
'''html
<!DOCTYPE html>
...
'''
* 代码块外不要输出与 HTML 无关的大段说明。
* 程序只会提取三单引号代码块内部内容。`;

  return [
    {
      key: 'readmeHtmlSystemPrompt',
      name: 'README HTML 系统提示词',
      category: 'README HTML',
      isTemplate: false,
      templateVars: [],
      defaultText: '',
      filePath: 'prompts/final_prompt.txt',
    },
    {
      key: 'readmeHtmlOutputWrapper',
      name: 'README HTML 输出包裹规则',
      category: 'README HTML',
      isTemplate: false,
      templateVars: [],
      defaultText: readmeHtmlOutputWrapperDefault,
      filePath: null,
    },
    {
      key: 'readmeHtmlUserPrompt',
      name: 'README HTML 用户提示词',
      category: 'README HTML',
      isTemplate: true,
      templateVars: ['repo.name', 'repoUrl', 'readmeResult.path', 'readmeResult.content'],
      defaultText: '请基于以下 GitHub 仓库 README 生成完整 HTML。\n仓库名：\${repo.name}\n仓库链接：\${repoUrl}\nREADME 文件：\${readmeResult.path}\n\nREADME 内容：\n\${readmeResult.content}',
      filePath: null,
    },
    {
      key: 'readmeHtmlRetryUserPrompt',
      name: 'README HTML 重试提示词',
      category: 'README HTML',
      isTemplate: true,
      templateVars: ['baseUserPrompt', 'errorLine', 'previewLine'],
      defaultText: '\${baseUserPrompt}\n\n上一次返回未通过程序提取，请重新生成一次完整 HTML。\n\${errorLine}\n\${previewLine}\n\n强制要求：\n1. 只输出一个代码块，不要输出解释、说明、前言或结尾。\n2. 优先使用三单引号代码块，格式必须是：\n\'\'\'html\n<!DOCTYPE html>\n...\n\'\'\'\n3. 如果你没有使用三单引号，至少也要直接输出完整 HTML 文档本体，不要夹杂任何额外文字。\n4. HTML 必须完整，包含 <!DOCTYPE html>。',
      filePath: null,
    },
    {
      key: 'readmeNarrationUserPrompt',
      name: '解说词用户提示词',
      category: 'Narration',
      isTemplate: true,
      templateVars: ['repo.name', 'repo.url', 'htmlContent'],
      defaultText: '你是一位专业的中文讲解文案助手。请基于以下 GitHub 仓库信息与最终展示 HTML，生成一段用于 TTS 配音的中文解说词。\n\n要求：\n1. 只输出解说词正文，不要标题、项目符号、引号、括号说明、Markdown、代码块。\n2. 使用自然、流畅、口语化的中文，适合直接朗读。\n3. 长度控制在 20 到 50 字之间。\n4. 聚焦仓库的定位、亮点、技术特征和使用价值。\n5. 不要提及"HTML""卡片""README""代码块""页面将展示"等生成过程描述。\n\n仓库名：\${repo.name}\n仓库链接：\${repo.url}\n\n最终 HTML：\n\${htmlContent}',
      filePath: null,
    },
    {
      key: 'narrationSystemPrompt',
      name: '解说词系统提示词',
      category: 'Narration',
      isTemplate: false,
      templateVars: [],
      defaultText: '你是一位专业的中文讲解文案助手，只输出适合直接朗读的中文解说词正文。',
      filePath: null,
    },
    {
      key: 'tagAnalysisPrompt',
      name: '标签分析提示词',
      category: 'Analysis',
      isTemplate: false,
      templateVars: [],
      defaultText: '你是一个GitHub项目分析专家。请分析以下仓库，对每个仓库：\n1. 生成1-3个标签（技术领域/用途/特点）\n2. 用一句话描述它的核心内容\n\n重要规则：\n- 【不要误判】如果仓库有 Forks（Forks > 0），说明有其他开发者在使用，这是一个有意义的信号，请不要标记为"无意义"——即使描述为空也要根据名称关键词推断用途\n- 只有同时满足以下条件时才标记为"无意义"：仓库名形如"随机用户名/star-十六进制"（如 SomeRandomUser/star-4833d8），或名称是明显随机拼接的单词，且 Forks 为 0\n- 对于正常仓库，即使描述为空，也请根据名称中的技术关键词（如 react、vue、compiler、engine 等）推断用途\n\n标签规范化（必须遵守）：\n- 语言标签统一使用标准名称：JavaScript/TypeScript/Python/Java/Go/C++/C#/Rust/Ruby/Swift/Kotlin/Shell/PHP/C/R\n- 框架/库标签统一：React/Vue/Angular/Svelte/Next.js/Nuxt/Node.js/Express/Django/Flask/FastAPI/Spring/.NET\n- 不要使用变体或缩写（如不要写 JS/Javascript/JSX，统一写 JavaScript）\n- 用途标签统一：UI框架/后端/前端/数据库/DevOps/CLI工具/API/机器学习/数据可视化/游戏/自动化/安全\n- 同类标签必须合并，不要拆分（如 "AI" 和 "人工智能" 统一写 "AI"，"ML" 和 "机器学习" 统一写 "机器学习"）\n\n输出约束（必须严格遵守）：\n- 每个仓库只输出一行，不要输出标题、解释、备注、代码块或额外说明\n- 每行严格使用半角竖线 "|" 作为分隔符，严格使用半角逗号 "," 分隔多个标签\n- 标签只能包含中文、英文字母、数字，以及 "+"、"#"、"."、"-"，不要包含 emoji、引号、括号、斜杠、反斜杠、冒号、分号、星号或任何不可见字符\n- 标签不要带序号、项目符号或前后空格，不要使用全角标点\n- 如果不确定，请优先使用上面列出的标准标签，不要自造奇怪标签\n\n格式要求：每个仓库一行，格式为：仓库名|标签1,标签2,标签3|一句话描述\n例如：facebook/react|JavaScript,UI框架,前端|React是一个用于构建用户界面的声明式JavaScript库\n例如：SomeRandomUser/star-4833d8|无意义|该仓库无意义\n\n请简洁回答，使用中文。',
      filePath: null,
    },
    {
      key: 'descSupplementPrompt',
      name: '描述补全提示词',
      category: 'Analysis',
      isTemplate: false,
      templateVars: [],
      defaultText: '以下是几个信息不足的GitHub仓库，以及可能相关的历史仓库描述作为参考。请为每个仓库提供1-3个标签和一句话描述。\n\n格式：仓库名|标签1,标签2|一句话描述\n\n判断规则：\n- 如果仓库有 Forks（Forks > 0），说明有实际用户在用，请不要标记为"无意义"，根据名称关键词推断用途\n- 只有仓库名形如"随机用户名/star-十六进制"且 Forks 为 0 时，才标记为"无意义"\n- 请根据名称中的技术关键词和历史参考信息进行推断\n\n标签规范化：\n- 语言统一：JavaScript/TypeScript/Python/Go/Rust/Java/C++/C#/Swift/Kotlin 等标准名称\n- AI/人工智能统一写 AI，ML/机器学习统一写 机器学习，LLM/大语言模型统一写 大模型\n- 同类标签必须合并，不要拆分（如 "UI框架" 和 "前端框架" 统一写 "UI框架"）\n\n输出约束（必须严格遵守）：\n- 每个仓库只输出一行，不要输出标题、解释、备注、代码块或额外说明\n- 每行严格使用半角竖线 "|" 作为分隔符，严格使用半角逗号 "," 分隔多个标签\n- 标签只能包含中文、英文字母、数字，以及 "+"、"#"、"."、"-"，不要包含 emoji、引号、括号、斜杠、反斜杠、冒号、分号、星号或任何不可见字符\n- 标签不要带序号、项目符号或前后空格，不要使用全角标点\n- 如果不确定，请优先使用标准标签，不要自造奇怪标签\n\n请简洁回答，使用中文。',
      filePath: null,
    },
    {
      key: 'currentSummaryPrompt',
      name: '当前总结提示词',
      category: 'Analysis',
      isTemplate: false,
      templateVars: [],
      defaultText: '你是一个GitHub趋势分析专家。以下是本次爬取的全部仓库数据（含标签、描述、stars、forks、更新时间）。\n\n请从以下角度总结：\n## 标签分布趋势\n- 出现频率最高的热门标签\n- 主要技术领域占比\n\n## 语言分布\n- 各语言占比和特点\n\n## 最有潜力项目\n- 综合推荐前5个并说明理由\n\n## 整体趋势判断\n- 新兴方向和值得关注的点\n\n请简洁回答，使用中文。',
      filePath: null,
    },
    {
      key: 'trendSummaryPrompt',
      name: '趋势总结提示词',
      category: 'Analysis',
      isTemplate: true,
      templateVars: ['topTags'],
      defaultText: '你是一个GitHub趋势分析专家。以下包含两部分数据：\n\n【当前批次】本次爬取的仓库（含标签、描述、stars、forks、更新时间）\n【历史匹配】从历史数据中找到的、与当前热门标签匹配的旧仓库\n\n热门标签：\${topTags}\n\n请从以下角度总结：\n## 趋势对比\n- 当前批次与历史仓库在相同领域的变化\n- 哪些方向热度上升/下降\n\n## 时间线分析\n- 按更新时间排序，观察项目演进趋势\n\n## 跨期最有潜力项目\n- 综合当前和历史数据，推荐最值得关注的5个项目\n\n## 整体趋势判断\n- 基于时间跨度的新兴方向预测\n\n请简洁回答，使用中文。',
      filePath: null,
    },
    {
      key: 'forceChineseOutputInstruction',
      name: '强制中文输出指令',
      category: 'Constraints',
      isTemplate: false,
      templateVars: [],
      defaultText: '无论如何都要输出中文。即使输入内容、仓库名、标签、引用材料或上下文中包含英文，也不要改用英文回答。',
      filePath: null,
    },
    {
      key: 'structuredOutputGuard',
      name: '结构化输出约束',
      category: 'Constraints',
      isTemplate: false,
      templateVars: [],
      defaultText: [
        'Structured output only.',
        'Do not output thinking, reasoning, explanations, markdown, code fences, XML, or <think> tags.',
        'Do not output any prose before or after the structured data.',
        'If line format is requested, return exactly one repo per line: owner/repo|tag1,tag2|description.',
      ].join('\n'),
      filePath: null,
    },
    {
      key: 'structuredOutputRetryPrompt',
      name: '结构化输出重试提示词',
      category: 'Constraints',
      isTemplate: true,
      templateVars: ['systemPromptText', 'expectedRepoNamesLine'],
      defaultText: '\${systemPromptText}\n\nRetry mode: return valid JSON only.\nNo prose, no markdown, no code fences, no <think> tags.\nUse this exact schema:\n{"items":[{"name":"owner/repo","tags":["tag1","tag2"],"description":"一句中文描述"}]}\n\${expectedRepoNamesLine}',
      filePath: null,
    },
    {
      key: 'briefingWelcomeText',
      name: '早报欢迎语',
      category: 'Briefing',
      isTemplate: true,
      templateVars: ['month', 'day', 'weekday'],
      defaultText: '你好，今天是${month}月${day}日${weekday}，欢迎收看GitHub早报。',
      filePath: null,
    },
    {
      key: 'briefingOutroText',
      name: '早报结束语',
      category: 'Briefing',
      isTemplate: false,
      templateVars: [],
      defaultText: '今天的GitHub早报到此为止，欢迎下次收看',
      filePath: null,
    },
    {
      key: 'userSystemPrompt',
      name: '用户系统提示词',
      category: 'User',
      isTemplate: false,
      templateVars: [],
      defaultText: '',
      filePath: null,
    },
    {
      key: 'rssItemIntroPrompt',
      name: 'RSS 条目介绍提示词（单仓库）',
      category: 'RSS & Email',
      isTemplate: false,
      templateVars: [],
      defaultText: '你是一个GitHub项目推荐编辑。请为以下仓库各写一句20~50字的中文介绍，适合RSS订阅者快速了解项目价值。\n\n要求：\n1. 每行一个仓库，格式：仓库名|介绍\n2. 介绍控制在20~50个汉字，简洁有力\n3. 聚焦项目解决了什么问题、有什么特色\n4. 使用自然流畅的中文，不要堆砌关键词\n5. 不要包含标签、star数等元数据，纯文字介绍\n6. 不要提及"该仓库""这个项目"等冗余开头，直接描述',
      filePath: null,
    },
    {
      key: 'emailItemIntroPrompt',
      name: '邮件条目介绍提示词',
      category: 'RSS & Email',
      isTemplate: false,
      templateVars: [],
      defaultText: '你是一个GitHub项目推荐编辑。请为以下仓库各写一句20~50字的中文介绍，适合邮件订阅者阅读。\n\n要求：\n1. 每行一个仓库，格式：仓库名|介绍\n2. 介绍控制在20~50个汉字，有吸引力\n3. 突出项目亮点和实用价值，让读者有点击欲望\n4. 使用自然流畅的中文，不要堆砌关键词\n5. 不要包含标签、star数等元数据，纯文字介绍\n6. 不要提及"该仓库""这个项目"等冗余开头，直接描述',
      filePath: null,
    },
  ];
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

function shouldRetryNetworkError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toUpperCase();
  const retryCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EPROTO', 'ECONNABORTED', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_SSL_PACKET_LENGTH']);
  const retryMessages = ['socket disconnected', 'tls', 'ssl', 'network', 'connect'];
  return retryCodes.has(code) || retryMessages.some((k) => msg.includes(k));
}

async function withNetworkRetry(fn, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries && shouldRetryNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function httpsRequest(url, options, body, method = 'POST') {
  return withNetworkRetry(() => new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: options.headers,
      rejectUnauthorized: false,
    }, async (res) => {
      try {
        const data = await readResponseText(res);
        resolve({ statusCode: res.statusCode, data, headers: res.headers || {} });
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
  }));
}

function httpsGet(url, headers = {}) {
  return withNetworkRetry(() => new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.get({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers,
      rejectUnauthorized: false,
    }, async (res) => {
      try {
        const data = await readResponseText(res);
        resolve({ statusCode: res.statusCode, data });
      } catch (e) {
        reject(e);
      }
    }).on('error', reject);
  }));
}

function buildGitHubHeaders(token, extraHeaders = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'github-scout-app',
    ...extraHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeBase64Content(content = '') {
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

function sanitizeAiContent(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function flattenAiMessageContent(value) {
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return typeof value === 'string' ? value : '';
}

function extractOpenAiCompatibleMessage(parsed) {
  const choice = parsed?.choices?.[0] || {};
  const message = choice?.message || {};

  return {
    content: sanitizeAiContent(flattenAiMessageContent(message.content)),
    reasoningContent: sanitizeAiContent(
      flattenAiMessageContent(message.reasoning_content || message.reasoning || ''),
    ),
    finishReason: String(choice?.finish_reason || '').trim(),
  };
}

function getEmptyContentFallbackModel(baseUrl, model) {
  const normalizedBase = String(baseUrl || '').toLowerCase();
  const normalizedModel = String(model || '').toLowerCase();

  if (normalizedBase.includes('api.deepseek.com') && normalizedModel === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }

  return '';
}

function getStructuredOutputFallbackModel(baseUrl, model) {
  const originalModel = String(model || '').trim();
  const normalizedBase = String(baseUrl || '').toLowerCase();
  const normalizedModel = originalModel.toLowerCase();

  if (!originalModel) {
    return '';
  }

  if (normalizedBase.includes('api.deepseek.com') && normalizedModel === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }

  if (normalizedModel === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }

  if (/deepseek\/deepseek-r1(?::[\w-]+)?$/i.test(originalModel)) {
    return originalModel.replace(/deepseek-r1/i, 'deepseek-chat');
  }

  if (/deepseek-r1(?::[\w-]+)?$/i.test(originalModel)) {
    return originalModel.replace(/deepseek-r1/i, 'deepseek-chat');
  }

  if (/deepseek.*reasoner/i.test(originalModel)) {
    return originalModel.replace(/reasoner/ig, 'chat');
  }

  return '';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStructuredOutputText(content) {
  return sanitizeAiContent(String(content || ''))
    .replace(/\r\n/g, '\n')
    .replace(/<think>[\s\S]*?<\/think>/gi, '\n')
    .replace(/<\/?think>/gi, '\n')
    .replace(/```[^\n\r]*\r?\n/g, '\n')
    .replace(/```/g, '\n')
    .replace(/[\uFF5C\uFFE8\u2502\u2223]/g, '|')
    .replace(/[\uFF0C\u3001\uFE10\uFE11\uFF1B]/g, ',');
}

function resolveStructuredRepoName(rawName, expectedRepoNames = []) {
  const candidate = sanitizeText(rawName).replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
  const normalizedExpected = expectedRepoNames.map((name) => sanitizeText(name)).filter(Boolean);

  if (!candidate) {
    return '';
  }

  if (normalizedExpected.length === 0) {
    const inlineMatch = candidate.match(/[\w.-]+\/[\w.-]+/);
    return inlineMatch ? inlineMatch[0] : (candidate.includes('/') ? candidate : '');
  }

  const expectedByLower = new Map(normalizedExpected.map((name) => [name.toLowerCase(), name]));
  const directMatch = expectedByLower.get(candidate.toLowerCase());
  if (directMatch) {
    return directMatch;
  }

  const inlineMatches = candidate.match(/[\w.-]+\/[\w.-]+/g) || [];
  for (const match of inlineMatches) {
    const expectedMatch = expectedByLower.get(match.toLowerCase());
    if (expectedMatch) {
      return expectedMatch;
    }
  }

  const loweredCandidate = candidate.toLowerCase();
  for (const name of normalizedExpected) {
    if (loweredCandidate.includes(name.toLowerCase())) {
      return name;
    }
  }

  return '';
}

function normalizeStructuredTags(tagsValue) {
  const tagList = Array.isArray(tagsValue)
    ? tagsValue
    : String(tagsValue || '').split(/[,\uFF0C\u3001\uFF1B;]+/);

  return [...new Set(
    tagList
      .map((tag) => sanitizeTag(String(tag || '').replace(/^\d+[.)-]?\s*/, '')))
      .filter(Boolean),
  )];
}

function normalizeStructuredDescription(descriptionValue) {
  return sanitizeText(Array.isArray(descriptionValue) ? descriptionValue.join(' ') : descriptionValue)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
}

function normalizeStructuredRepoEntry(rawName, rawTags, rawDescription, expectedRepoNames = []) {
  const name = resolveStructuredRepoName(rawName, expectedRepoNames);
  const tags = normalizeStructuredTags(rawTags);
  const description = normalizeStructuredDescription(rawDescription);

  if (!name || tags.length === 0) {
    return null;
  }

  return {
    name,
    data: {
      tags,
      description,
    },
  };
}

function parseStructuredRepoTagMap(content, expectedRepoNames = []) {
  const tagMap = {};
  const normalizedText = normalizeStructuredOutputText(content);
  const lines = normalizedText
    .split('\n')
    .map((line) => sanitizeText(line))
    .filter(Boolean);

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^\s*(?:[-*•+]|(?:\d+|[ivxlcdm]+)[.)])\s*/iu, '')
      .replace(/\s*\|\s*/g, '|');
    const parts = line.split('|');
    if (parts.length < 3) {
      continue;
    }

    const entry = normalizeStructuredRepoEntry(
      parts[0].replace(/^(?:repo|repository)\s*[:\-]?\s*/i, ''),
      parts[1].replace(/^(?:tags?)\s*[:\-]?\s*/i, ''),
      parts.slice(2).join('|').replace(/^(?:description|desc)\s*[:\-]?\s*/i, ''),
      expectedRepoNames,
    );

    if (entry) {
      tagMap[entry.name] = entry.data;
    }
  }

  if (Object.keys(tagMap).length > 0 || expectedRepoNames.length === 0) {
    return tagMap;
  }

  for (const repoName of expectedRepoNames) {
    const pattern = new RegExp(`${escapeRegex(repoName)}\\s*\\|\\s*([^|\\n]+)\\|\\s*([^\\n]+)`, 'i');
    const match = normalizedText.match(pattern);
    if (!match) {
      continue;
    }

    const entry = normalizeStructuredRepoEntry(repoName, match[1], match[2], expectedRepoNames);
    if (entry) {
      tagMap[entry.name] = entry.data;
    }
  }

  return tagMap;
}

function getStructuredJsonCandidates(content) {
  const raw = sanitizeAiContent(String(content || ''));
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  pushCandidate(raw);

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    pushCandidate(fenceMatch[1]);
  }

  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    pushCandidate(raw.slice(arrayStart, arrayEnd + 1));
  }

  const objectStart = raw.indexOf('{');
  const objectEnd = raw.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    pushCandidate(raw.slice(objectStart, objectEnd + 1));
  }

  return candidates;
}

function parseStructuredRepoTagMapFromJson(content, expectedRepoNames = []) {
  for (const candidate of getStructuredJsonCandidates(content)) {
    const parsed = parseJsonSafely(candidate);
    if (!parsed) {
      continue;
    }

    let items = [];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (Array.isArray(parsed?.items)) {
      items = parsed.items;
    } else if (Array.isArray(parsed?.repositories)) {
      items = parsed.repositories;
    } else if (parsed && typeof parsed === 'object') {
      items = Object.entries(parsed).map(([name, value]) => ({
        name,
        ...(value && typeof value === 'object' ? value : { description: value }),
      }));
    }

    const tagMap = {};
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const entry = normalizeStructuredRepoEntry(
        item.name || item.repo || item.repository || item.full_name || item.fullName || '',
        item.tags || item.labels || item.keywords || [],
        item.description || item.desc || item.summary || item.reason || '',
        expectedRepoNames,
      );

      if (entry) {
        tagMap[entry.name] = entry.data;
      }
    }

    if (Object.keys(tagMap).length > 0) {
      return tagMap;
    }
  }

  return {};
}

function buildStructuredPreview(content, maxLength = 200) {
  return normalizeStructuredOutputText(content)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function shouldRetryAiError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('aborted')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('socket hang up')
  );
}

function buildNonJsonAiResponseMessage(statusCode, contentType, responseText) {
  const preview = sanitizeAiContent(String(responseText || '').replace(/\s+/g, ' ').trim()).slice(0, 180);
  const contentTypeLabel = contentType ? `, ${contentType}` : '';
  return `上游返回了非 JSON 响应 (HTTP ${statusCode}${contentTypeLabel})${preview ? `，预览: ${preview}` : ''}`;
}

async function callAiChat(aiConfig, messages, options = {}) {
  const { baseUrl, apiKey, model } = aiConfig || {};
  if (!baseUrl || !apiKey) {
    return { ok: false, message: 'AI 配置不完整' };
  }

  const provider = getProvider(baseUrl);
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanMessages = messages.map((message) => ({
    ...message,
    content: sanitizeAiContent(message.content),
  }));
  const timeout = options.timeout || 300000;
  const maxTokens = options.maxTokens || 4096;
  const temperature = options.temperature ?? 0.7;

  if (provider === 'anthropic') {
    const url = `${cleanBase}/v1/messages`;
    const body = JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      system: cleanMessages.find((message) => message.role === 'system')?.content || '',
      max_tokens: maxTokens,
      messages: cleanMessages.filter((message) => message.role !== 'system'),
      temperature,
    });
    const res = await httpsRequest(url, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'github-scout-app',
      },
      timeout,
    }, body);
    const parsed = parseJsonSafely(res.data);
    if (!parsed) {
      return {
        ok: false,
        message: buildNonJsonAiResponseMessage(res.statusCode, res.headers?.['content-type'], res.data),
      };
    }
    if (res.statusCode === 200) {
      const raw = sanitizeAiContent(parsed.content?.[0]?.text || '');
      if (!raw) {
        return { ok: false, message: `模型 ${model || parsed.model || 'unknown'} 返回空正文` };
      }
      return { ok: true, content: raw, model: parsed.model || model };
    }
    return { ok: false, message: parsed.error?.message || `HTTP ${res.statusCode}` };
  }

  const url = `${cleanBase}/v1/chat/completions`;
  const requestOpenAiCompatibleChat = async (requestModel) => {
    const body = JSON.stringify({
      model: requestModel || 'gpt-3.5-turbo',
      messages: cleanMessages,
      max_tokens: maxTokens,
      temperature,
    });
    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'github-scout-app',
      },
      timeout,
    };
    let res;
    try {
      res = await httpsRequest(url, requestConfig, body);
    } catch (error) {
      if (!shouldRetryAiError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      res = await httpsRequest(url, requestConfig, body);
    }
    let parsed = parseJsonSafely(res.data);
    if (!parsed) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      res = await httpsRequest(url, requestConfig, body);
      parsed = parseJsonSafely(res.data);
    }

    if (!parsed) {
      return {
        ok: false,
        message: buildNonJsonAiResponseMessage(res.statusCode, res.headers?.['content-type'], res.data),
      };
    }

    if (res.statusCode !== 200) {
      return {
        ok: false,
        message: parsed.error?.message || `HTTP ${res.statusCode}`,
      };
    }

    const message = extractOpenAiCompatibleMessage(parsed);
    return {
      ok: true,
      content: message.content,
      reasoningContent: message.reasoningContent,
      finishReason: message.finishReason,
      model: parsed.model || requestModel,
    };
  };

  const primaryModel = model || 'gpt-3.5-turbo';
  const primaryResult = await requestOpenAiCompatibleChat(primaryModel);
  if (!primaryResult.ok) {
    return primaryResult;
  }

  if (primaryResult.content) {
    return {
      ok: true,
      content: primaryResult.content,
      model: primaryResult.model || primaryModel,
    };
  }

  const fallbackModel = getEmptyContentFallbackModel(cleanBase, primaryModel);
  if (fallbackModel && fallbackModel !== primaryModel) {
    log(`[AI] 模型 ${primaryModel} 返回空正文，自动回退到 ${fallbackModel}`, 'warn');
    const fallbackResult = await requestOpenAiCompatibleChat(fallbackModel);
    if (fallbackResult.ok && fallbackResult.content) {
      return {
        ok: true,
        content: fallbackResult.content,
        model: fallbackResult.model || fallbackModel,
      };
    }
    if (!fallbackResult.ok) {
      return fallbackResult;
    }
  }

  const finishReasonSuffix = primaryResult.finishReason
    ? `（finish_reason: ${primaryResult.finishReason}）`
    : '';
  if (primaryResult.reasoningContent) {
    return {
      ok: false,
      message: `模型 ${primaryModel} 仅返回推理内容，未返回正文${finishReasonSuffix}`,
    };
  }
  return {
    ok: false,
    message: `模型 ${primaryModel} 返回空正文${finishReasonSuffix}`,
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadReadmeHtmlPrompt() {
  let fileContent = '';
  if (fs.existsSync(PROMPT_FILE)) {
    fileContent = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
  }
  if (!resolvePrompt('readmeHtmlSystemPrompt', fileContent) && !fileContent) {
    throw new Error(`提示词文件不存在或为空: ${PROMPT_FILE}`);
  }

  let promptText = resolvePrompt('readmeHtmlSystemPrompt', fileContent);
  if (!promptText) {
    throw new Error(`提示词文件为空: ${PROMPT_FILE}`);
  }

  // Inject repo footer font size from presentation settings
  const presentationConfig = loadPresentationConfig();
  const footerFontSize = presentationConfig.repoFooterFontSize || 14;
  promptText = promptText.replace(/\$\{repoFooterFontSize\}/g, String(footerFontSize));

  const outputWrapper = resolvePrompt('readmeHtmlOutputWrapper',
    `### 输出包裹规则（强制）
* 最终完整 HTML 必须放在一个三单引号代码块中。
* 优先使用以下格式：
'''html
<!DOCTYPE html>
...
'''
* 代码块外不要输出与 HTML 无关的大段说明。
* 程序只会提取三单引号代码块内部内容。`);

  return `${promptText}\n\n${outputWrapper}`;
}

function extractHtmlFromAiResponse(content) {
  const text = sanitizeAiContent(String(content || '')).trim();
  if (!text) {
    return '';
  }

  const blockPatterns = [
    /'''[ \t]*html[^\n\r]*\r?\n([\s\S]*?)'''/ig,
    /'''(?:[ \t]*[^\n\r]*)?\r?\n([\s\S]*?)'''/g,
    /```[ \t]*html[^\n\r]*\r?\n([\s\S]*?)```/ig,
    /```(?:[ \t]*[^\n\r]*)?\r?\n([\s\S]*?)```/g,
  ];

  for (const pattern of blockPatterns) {
    let match = null;
    while ((match = pattern.exec(text)) !== null) {
      const extracted = String(match[1] || '').trim();
      if (/<(?:!DOCTYPE\s+html|html|body)\b/i.test(extracted)) {
        return extracted;
      }
    }
  }

  const doctypeIndex = text.search(/<!DOCTYPE\s+html/i);
  if (doctypeIndex !== -1) {
    const extracted = text.slice(doctypeIndex).trim();
    if (/<\/html>/i.test(extracted) || /<\/body>/i.test(extracted)) {
      return extracted;
    }
  }

  const htmlIndex = text.search(/<html\b/i);
  if (htmlIndex !== -1) {
    const extracted = text.slice(htmlIndex).trim();
    if (/<\/html>/i.test(extracted)) {
      return extracted;
    }
  }

  if (/<body\b/i.test(text) && /<\/body>/i.test(text)) {
    return text;
  }

  return '';
}

function sanitizeRepoFileName(repoName, index) {
  const safeRepo = String(repoName || `repo-${index + 1}`)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return `${String(index + 1).padStart(2, '0')}-${safeRepo || `repo-${index + 1}`}`;
}

function copyRepoImagesToOutput(selectedImagePaths, repoDirPath) {
  const normalizedPaths = Array.isArray(selectedImagePaths)
    ? selectedImagePaths
      .filter((filePath) => typeof filePath === 'string' && filePath.trim())
      .map((filePath) => path.resolve(filePath))
    : [];

  if (normalizedPaths.length === 0) {
    return {
      imageCount: 0,
      imageDirPath: '',
      indexJsonPath: '',
      images: [],
      skippedPaths: [],
    };
  }

  const imageDirPath = path.join(repoDirPath, 'image');
  ensureDir(imageDirPath);

  const images = [];
  const skippedPaths = [];

  normalizedPaths.forEach((sourcePath, index) => {
    try {
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        skippedPaths.push(sourcePath);
        return;
      }

      const extension = path.extname(sourcePath).toLowerCase() || '.png';
      const safeExtension = extension.length <= 10 ? extension : '.png';
      const targetFileName = `${index + 1}${safeExtension}`;
      const targetPath = path.join(imageDirPath, targetFileName);
      fs.copyFileSync(sourcePath, targetPath);
      images.push(`./image/${targetFileName}`);
    } catch {
      skippedPaths.push(sourcePath);
    }
  });

  if (images.length === 0) {
    return {
      imageCount: 0,
      imageDirPath,
      indexJsonPath: '',
      images: [],
      skippedPaths,
    };
  }

  const indexJsonPath = path.join(imageDirPath, 'index.json');
  fs.writeFileSync(indexJsonPath, JSON.stringify({ images }, null, 2), 'utf8');

  return {
    imageCount: images.length,
    imageDirPath,
    indexJsonPath,
    images,
    skippedPaths,
  };
}

function stringifyInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildLocalImageManifestBridge(images) {
  const manifest = {
    images: Array.isArray(images) ? images.filter((item) => typeof item === 'string' && item.trim()) : [],
  };
  const manifestJson = stringifyInlineJson(manifest);

  return `
<script id="local-image-manifest" type="application/json">${manifestJson}</script>
<script>
(function () {
  const embeddedManifest = ${manifestJson};
  window.__LOCAL_IMAGE_MANIFEST__ = embeddedManifest;

  if (typeof window.fetch !== 'function') {
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(resource, init) {
    const requestUrl = typeof resource === 'string'
      ? resource
      : (resource && typeof resource.url === 'string' ? resource.url : '');
    const normalizedUrl = String(requestUrl || '').trim();
    const isLocalImageIndex =
      normalizedUrl === './image/index.json' ||
      normalizedUrl === 'image/index.json' ||
      /(?:^|[\\\\/])image[\\\\/]index\\.json(?:$|[?#])/i.test(normalizedUrl);

    if (!isLocalImageIndex) {
      return originalFetch(resource, init);
    }

    if (typeof Response === 'function') {
      return Promise.resolve(new Response(JSON.stringify(embeddedManifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      json: async function json() { return embeddedManifest; },
      text: async function text() { return JSON.stringify(embeddedManifest); },
    });
  };
})();
</script>`;
}

function buildPageAudioDurationBridge(audioDurationMs) {
  const normalizedDurationMs = Number.isFinite(Number(audioDurationMs)) && Number(audioDurationMs) > 0
    ? Math.round(Number(audioDurationMs))
    : null;

  return `<script id="repo-page-audio-duration-script">window.__PAGE_AUDIO_DURATION_MS__ = ${normalizedDurationMs === null ? 'null' : normalizedDurationMs};</script>`;
}

function injectPageAudioDurationIntoHtml(htmlContent, audioDurationMs) {
  const html = String(htmlContent || '').trim();
  if (!html) {
    return html;
  }

  const durationBridge = buildPageAudioDurationBridge(audioDurationMs);
  const withoutOldBridge = html.replace(/\s*<script[^>]+id=["']repo-page-audio-duration-script["'][\s\S]*?<\/script>/ig, '');

  if (/<head[^>]*>/i.test(withoutOldBridge)) {
    return withoutOldBridge.replace(/<head([^>]*)>/i, `<head$1>\n${durationBridge}`);
  }

  if (/<html[^>]*>/i.test(withoutOldBridge)) {
    return withoutOldBridge.replace(/<html([^>]*)>/i, `<html$1><head>${durationBridge}</head>`);
  }

  return `<!DOCTYPE html><html><head>${durationBridge}</head><body>${withoutOldBridge}</body></html>`;
}

let cachedFontBase64 = null;

function getFontBase64() {
  if (cachedFontBase64) {
    return cachedFontBase64;
  }
  if (!fs.existsSync(HTML_FONT_SOURCE_PATH)) {
    return '';
  }
  cachedFontBase64 = fs.readFileSync(HTML_FONT_SOURCE_PATH).toString('base64');
  return cachedFontBase64;
}

function injectFontIntoHtml(htmlContent) {
  const fontBase64 = getFontBase64();
  if (!fontBase64) {
    return htmlContent;
  }

  const html = String(htmlContent || '').trim();
  if (!html) {
    return html;
  }

  const styleTag = `${SOURCE_APP_FONT_LINKS}
<style id="repo-custom-font-style">
  @font-face {
    font-family: 'htmlFont';
    src: url(data:font/ttf;base64,${fontBase64}) format('truetype');
  }
  body {
    font-family: ${SOURCE_APP_FONT_STACK} !important;
  }
  .main-container {
    font-family: ${SOURCE_APP_FONT_STACK} !important;
  }
</style>`;

  const cleaned = html
    .replace(/\s*<style[^>]+id=["']repo-custom-font-style["'][\s\S]*?<\/style>/ig, '')
    .replace(/\s*<link[^>]+id=["']repo-google-fonts-(?:preconnect|gstatic-preconnect|stylesheet)["'][^>]*>/ig, '');

  if (/<\/head>/i.test(cleaned)) {
    return cleaned.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }

  if (/<head[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head([^>]*)>/i, `<head$1>\n${styleTag}`);
  }

  return `<!DOCTYPE html><html><head>${styleTag}</head><body>${cleaned}</body></html>`;
}

function injectLocalImageManifestIntoHtml(htmlContent, images, audioDurationMs = null) {
  let html = injectFontIntoHtml(htmlContent);
  html = injectPageAudioDurationIntoHtml(html, audioDurationMs);
  const normalizedImages = Array.isArray(images)
    ? images.filter((item) => typeof item === 'string' && item.trim())
    : [];

  if (!html) {
    return html;
  }

  html = html
    .replace(/\s*<div[^>]+id=["']repo-local-image-overlay["'][\s\S]*?<\/div>/ig, '')
    .replace(/\s*<script[^>]+id=["']repo-local-image-runtime-script["'][\s\S]*?<\/script>/ig, '');

  if (normalizedImages.length === 0) {
    return html;
  }

  html = injectLocalImageRuntimeStyle(html);

  if (/<script[^>]+id=["']local-image-manifest["']/i.test(html)) {
    return html;
  }

  const injection = buildLocalImageManifestBridge(normalizedImages);

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${injection}\n</body>`);
  }

  return `${html}\n${injection}`;
}

async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= list.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await worker(list[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => runWorker()));
  return results;
}

function buildReadmeNarrationPrompt(repo, htmlContent) {
  const template = resolvePrompt('readmeNarrationUserPrompt',
    `你是一位专业的中文讲解文案助手。请基于以下 GitHub 仓库信息与最终展示 HTML，生成一段用于 TTS 配音的中文解说词。

要求：
1. 只输出解说词正文，不要标题、项目符号、引号、括号说明、Markdown、代码块。
2. 使用自然、流畅、口语化的中文，适合直接朗读。
3. 长度控制在 20 到 50 字之间。
4. 聚焦仓库的定位、亮点、技术特征和使用价值。
5. 不要提及”HTML””卡片””README””代码块””页面将展示”等生成过程描述。

仓库名：\${repo.name}
仓库链接：\${repo.url}

最终 HTML：
\${htmlContent}`);
  return template
    .replace(/\$\{repo\.name\}/g, repo.name)
    .replace(/\$\{repo\.url\}/g, repo.url || `https://github.com/${repo.name}`)
    .replace(/\$\{htmlContent\}/g, htmlContent);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const GITHUB_BRIEFING_TIME_ZONE = 'Asia/Shanghai';
const GITHUB_BRIEFING_OUTRO_TEXT = resolvePrompt('briefingOutroText', '今天的GitHub早报到此为止，欢迎下次收看');

function getGitHubBriefingDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: GITHUB_BRIEFING_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(date);

  const pickValue = (type, fallback) => parts.find((part) => part.type === type)?.value || fallback;

  return {
    month: pickValue('month', String(date.getMonth() + 1)),
    day: pickValue('day', String(date.getDate())),
    weekday: pickValue('weekday', '星期一'),
  };
}

function buildGitHubBriefingWelcomeText(date = new Date()) {
  const { month, day, weekday } = getGitHubBriefingDateParts(date);
  const template = resolvePrompt('briefingWelcomeText',
    '你好，今天是\${month}月\${day}日\${weekday}，欢迎收看GitHub早报。');
  return template
    .replace(/\$\{month\}/g, month)
    .replace(/\$\{day\}/g, day)
    .replace(/\$\{weekday\}/g, weekday);
}

function buildGitHubBriefingDateLabel(date = new Date()) {
  const { month, day, weekday } = getGitHubBriefingDateParts(date);
  return `${month} 月 ${day} 日 · ${weekday}`;
}

function buildBriefingNarrationCardHtml({
  kicker,
  title,
  body,
  dateLabel,
}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
${SOURCE_APP_FONT_LINKS}
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,300,0,0&display=swap" rel="stylesheet" />
  <style>
    @font-face {
      font-family: 'htmlFont';
      src: url('../htmlFont.ttf') format('truetype');
      font-weight: 100 900;
      font-style: normal;
      font-display: block;
    }
    *, ::before, ::after { box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      overflow: hidden;
      background-color: #fbf9f6;
      font-family: ${SOURCE_APP_FONT_STACK};
    }

    .main-container {
      background-color: #fbf9f6;
      color: #4a403a;
    }

    .warm-title {
      font-weight: 700;
      color: #c96442;
      line-height: 1.2;
      white-space: nowrap;
      text-shadow: 2px 2px 0 rgba(201, 100, 66, 0.1);
    }

    .material-symbols-rounded {
      font-family: 'Material Symbols Rounded' !important;
      font-weight: 300 !important;
      font-style: normal;
      display: inline-block;
      line-height: 1;
      text-transform: none;
      letter-spacing: normal;
      white-space: nowrap;
      direction: ltr;
      font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24 !important;
    }

    .card-item {
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .card-width-2col { width: calc((100% - var(--container-gap)) / 2 - 1px); }
    .text-4-5xl { font-size: 2.625rem; line-height: 1.2; }
    .text-3-25xl { font-size: 2rem; line-height: 1.35; }

    .card-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .js-desc strong { font-weight: 700; }
    .content-scale { transform-origin: center center; }

    .title-zone,
    .card-item {
      opacity: 0;
      transform: translateY(18px);
    }

    body.motion-ready .title-zone {
      opacity: 1;
      transform: translateY(0);
      transition: opacity 560ms cubic-bezier(0.22, 1, 0.36, 1), transform 560ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    body.motion-ready .card-item {
      opacity: 1;
      transform: translateY(0);
      transition: opacity 620ms cubic-bezier(0.22, 1, 0.36, 1), transform 620ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease;
    }

    @media (prefers-reduced-motion: reduce) {
      .title-zone,
      .card-item,
      body.motion-ready .title-zone,
      body.motion-ready .card-item {
        opacity: 1 !important;
        transform: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="main-container w-[1920px] h-[1080px] relative overflow-hidden box-border bg-[#fbf9f6]">
    <div class="content-wrapper w-full h-full flex flex-col justify-center items-center px-24 box-border content-scale z-10" style="gap: 72px;">
      <div class="title-zone flex-none flex items-center justify-center w-full">
        <h1 class="main-title warm-title text-center">${escapeHtml(title)}</h1>
      </div>
      <div class="card-zone flex-none w-full">
        <div id="card-dynamic-container" class="flex flex-wrap justify-center w-full" style="gap: 24px; --container-gap: 24px;">
          <div class="card-item card-width-2col flex flex-col" style="padding: 8px; background-color: #ffffff; border-radius: 32px; border: 1px solid rgb(218, 216, 212); box-shadow: 0 10px 30px -10px rgba(74, 64, 58, 0.1);">
            <div class="title-box flex items-center gap-2 mb-0 px-5 pt-5 pb-2">
              <span class="js-icon material-symbols-rounded" style="font-size: 64px; color: #c96442;">calendar_month</span>
              <h3 class="card-title font-bold leading-tight text-4-5xl" style="color: #c96442;">${escapeHtml(kicker)}</h3>
            </div>
            <div class="card-body flex-1 w-full px-5 pb-5 pt-0" style="min-height: 80px;">
              <p class="js-desc font-medium leading-relaxed text-3-25xl"><strong>${escapeHtml(dateLabel || '')}</strong></p>
            </div>
          </div>
          <div class="card-item card-width-2col flex flex-col" style="padding: 8px; background-color: #ffffff; border-radius: 32px; border: 1px solid rgb(218, 216, 212); box-shadow: 0 10px 30px -10px rgba(74, 64, 58, 0.1);">
            <div class="title-box flex items-center gap-2 mb-0 px-5 pt-5 pb-2">
              <span class="js-icon material-symbols-rounded" style="font-size: 64px; color: #335c67;">campaign</span>
              <h3 class="card-title font-bold leading-tight text-4-5xl" style="color: #335c67;">欢迎收看</h3>
            </div>
            <div class="card-body flex-1 w-full px-5 pb-5 pt-0" style="min-height: 80px;">
              <p class="js-desc font-medium leading-relaxed text-3-25xl">${escapeHtml(body)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const wrapper = document.querySelector('.content-wrapper');
      const titleEl = document.querySelector('.main-title');
      const container = document.getElementById('card-dynamic-container');
      const cards = Array.from(container ? container.querySelectorAll('.card-item') : []);
      let motionStarted = false;

      if (!wrapper || !titleEl || !container) return;

      const fitTitle = () => {
        let size = 96;
        titleEl.style.fontSize = size + 'px';
        let guard = 0;
        while (titleEl.scrollWidth > 1700 && size > 52 && guard < 100) {
          size -= 1;
          titleEl.style.fontSize = size + 'px';
          guard += 1;
        }
      };

      const fitCardTitles = () => {
        const titleEls = wrapper.querySelectorAll('.card-title');
        titleEls.forEach((el) => {
          el.style.fontSize = '';
          const base = parseFloat(window.getComputedStyle(el).fontSize);
          if (!base) return;
          let fontSize = base;
          const minFontSize = Math.max(26, Math.floor(base * 0.72));
          let guard = 0;
          while (el.scrollWidth > el.clientWidth && fontSize > minFontSize && guard < 50) {
            fontSize -= 1;
            el.style.fontSize = fontSize + 'px';
            guard += 1;
          }
        });
      };

      const fitViewport = () => {
        const maxH = 1040;
        const contentH = wrapper.scrollHeight;
        if (contentH > maxH) {
          const scale = Math.max(0.7, maxH / contentH);
          wrapper.style.transform = 'scale(' + scale + ')';
          return;
        }
        wrapper.style.transform = '';
      };

      const runEntranceMotion = () => {
        if (motionStarted) return;
        motionStarted = true;
        cards.forEach((card, idx) => {
          card.style.transitionDelay = (120 + idx * 80) + 'ms';
        });
        document.body.classList.add('motion-ready');
      };

      fitTitle();
      fitCardTitles();
      setTimeout(fitViewport, 50);
      setTimeout(() => {
        fitCardTitles();
        fitViewport();
      }, 220);

      if (document.fonts?.ready) {
        Promise.race([
          document.fonts.ready,
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]).then(() => {
          requestAnimationFrame(() => {
            fitCardTitles();
            setTimeout(() => {
              fitViewport();
              runEntranceMotion();
            }, 50);
          });
        }).catch(() => {
          runEntranceMotion();
        });
      } else {
        runEntranceMotion();
      }

      window.addEventListener('resize', () => {
        fitTitle();
        fitCardTitles();
        fitViewport();
      });
    });
  </script>
</body>
</html>`;
}

function buildBriefingOutroBridge(closingText, revealDelayMs = 0) {
  const safeText = escapeHtml(closingText);
  const safeDelayMs = Number.isFinite(Number(revealDelayMs)) && Number(revealDelayMs) > 0
    ? Math.round(Number(revealDelayMs))
    : 0;

  return `
<style id="repo-briefing-outro-style">
  .repo-briefing-outro {
    position: fixed;
    left: 42px;
    bottom: 28px;
    z-index: 12;
    max-width: min(760px, calc(100vw - 96px));
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 22px;
    background-color: #ffffff;
    border: 1px solid rgb(218, 216, 212);
    border-radius: 32px;
    box-shadow: 0 10px 30px -10px rgba(74, 64, 58, 0.1);
    color: #4a403a;
    opacity: 0;
    transform: translateY(12px);
    transition: opacity 420ms cubic-bezier(0.22, 1, 0.36, 1), transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }

  .repo-briefing-outro.is-visible {
    opacity: 1;
    transform: translateY(0);
  }

  .repo-briefing-outro-kicker {
    flex: none;
    color: #9e2a2b;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .repo-briefing-outro-text {
    color: rgba(74, 64, 58, 0.78);
    font-size: 20px;
    line-height: 1.45;
    font-weight: 600;
  }

  @media (prefers-reduced-motion: reduce) {
    .repo-briefing-outro,
    .repo-briefing-outro.is-visible {
      transform: none !important;
      transition: none !important;
    }
  }
</style>
<div id="repo-briefing-outro-banner" class="repo-briefing-outro" aria-label="播报结束提示">
  <span class="repo-briefing-outro-kicker">播报结束</span>
  <span class="repo-briefing-outro-text">${safeText}</span>
</div>
<script id="repo-briefing-outro-script">
  window.__BRIEFING_OUTRO_REVEAL_MS__ = ${safeDelayMs};
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('repo-briefing-outro-banner');
    if (!banner) return;
    const revealDelayMs = Number(window.__BRIEFING_OUTRO_REVEAL_MS__);
    const showBanner = () => banner.classList.add('is-visible');
    if (!Number.isFinite(revealDelayMs) || revealDelayMs <= 0) {
      showBanner();
      return;
    }
    window.setTimeout(showBanner, revealDelayMs);
  });
</script>`;
}

function injectBriefingOutroIntoHtml(htmlContent, closingText, revealDelayMs = 0) {
  let html = String(htmlContent || '').trim();
  if (!html) {
    return html;
  }

  html = html
    .replace(/\s*<style[^>]+id=["']repo-briefing-outro-style["'][\s\S]*?<\/style>/ig, '')
    .replace(/\s*<div[^>]+id=["']repo-briefing-outro-banner["'][\s\S]*?<\/div>/ig, '')
    .replace(/\s*<script[^>]+id=["']repo-briefing-outro-script["'][\s\S]*?<\/script>/ig, '');
  return html;
}

function mergeNarrationWithOutro(baseText, outroText) {
  const normalizedBase = String(baseText || '').trim();
  const normalizedOutro = String(outroText || '').trim();

  if (!normalizedBase) return normalizedOutro;
  if (!normalizedOutro) return normalizedBase;
  if (/[.!?\u3002\uFF01\uFF1F]$/u.test(normalizedBase)) {
    return `${normalizedBase}${normalizedOutro}`;
  }
  return `${normalizedBase}\u3002${normalizedOutro}`;
}

async function mergeBriefingOutroIntoLastItem(items, outroText, ttsConfig) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const lastItem = items[items.length - 1];
  if (!lastItem?.htmlPath || !lastItem?.repoDirPath || !lastItem?.repoDirName) {
    return lastItem;
  }

  const mergedNarrationText = mergeNarrationWithOutro(lastItem.narrationText, outroText);
  const previousAudioDurationMs = Number(lastItem.audioDurationMs) || 0;
  const audioResult = await synthesizeTtsToCache(mergedNarrationText, ttsConfig);
  const audioExtension = path.extname(audioResult.audioPath) || path.extname(lastItem.audioFileName || '') || `.${ttsConfig.format || 'mp3'}`;
  const audioFileName = path.extname(lastItem.audioFileName || '') === audioExtension
    ? lastItem.audioFileName
    : `narration${audioExtension}`;
  const audioFilePath = path.join(lastItem.repoDirPath, audioFileName);
  const audioEntryPath = `${lastItem.repoDirName}/${audioFileName}`;
  const currentHtml = fs.readFileSync(lastItem.htmlPath, 'utf8');
  const htmlWithOutro = injectBriefingOutroIntoHtml(currentHtml, outroText, previousAudioDurationMs);
  const finalHtml = injectFontIntoHtml(injectPageAudioDurationIntoHtml(htmlWithOutro, audioResult.durationMs));

  fs.copyFileSync(audioResult.audioPath, audioFilePath);
  fs.writeFileSync(lastItem.htmlPath, finalHtml, 'utf8');

  lastItem.audioFileName = audioFileName;
  lastItem.audioPath = audioFilePath;
  lastItem.audioEntryPath = audioEntryPath;
  lastItem.audioDurationMs = audioResult.durationMs || null;
  lastItem.narrationText = mergedNarrationText;

  return lastItem;
}

async function createBriefingNarrationCardItem({
  outputDir,
  dirName,
  segmentType,
  title,
  ttsText,
  kicker,
  body,
  ttsConfig,
}) {
  const repoDirName = dirName;
  const repoDirPath = path.join(outputDir, repoDirName);
  const htmlFileName = 'index.html';
  const htmlFilePath = path.join(repoDirPath, htmlFileName);
  const htmlEntryPath = `${repoDirName}/${htmlFileName}`;

  ensureDir(repoDirPath);

  const audioResult = await synthesizeTtsToCache(ttsText, ttsConfig);
  const audioExtension = path.extname(audioResult.audioPath) || `.${ttsConfig.format || 'mp3'}`;
  const audioFileName = `narration${audioExtension}`;
  const audioFilePath = path.join(repoDirPath, audioFileName);
  const audioEntryPath = `${repoDirName}/${audioFileName}`;
  const cardHtml = buildBriefingNarrationCardHtml({
    kicker,
    title,
    body,
    dateLabel: buildGitHubBriefingDateLabel(),
  });
  const finalHtml = injectFontIntoHtml(injectPageAudioDurationIntoHtml(cardHtml, audioResult.durationMs));

  fs.writeFileSync(htmlFilePath, finalHtml, 'utf8');
  fs.copyFileSync(audioResult.audioPath, audioFilePath);

  return {
    title,
    repoName: '',
    repoUrl: '',
    repoDirName,
    repoDirPath,
    htmlFileName,
    htmlEntryPath,
    audioFileName,
    audioEntryPath,
    audioDurationMs: audioResult.durationMs || null,
    imageCount: 0,
    narrationText: ttsText,
    htmlPath: htmlFilePath,
    audioPath: audioFilePath,
    readmePath: '',
    segmentType,
  };
}

function copyPageTurnSoundToOutput(outputDir) {
  if (!outputDir || !fs.existsSync(PAGE_TURN_SOUND_SOURCE_PATH)) {
    return '';
  }

  const targetPath = path.join(outputDir, PAGE_TURN_SOUND_FILE_NAME);
  fs.copyFileSync(PAGE_TURN_SOUND_SOURCE_PATH, targetPath);
  return PAGE_TURN_SOUND_FILE_NAME;
}

function copyFontToOutput(outputDir) {
  if (!outputDir || !fs.existsSync(HTML_FONT_SOURCE_PATH)) {
    return '';
  }

  const targetPath = path.join(outputDir, HTML_FONT_FILE_NAME);
  fs.copyFileSync(HTML_FONT_SOURCE_PATH, targetPath);
  return HTML_FONT_FILE_NAME;
}

function buildCarouselIndexHtml(items, pageTurnSoundEntryPath = '', repoFooterFontSize = 14) {
  const payload = JSON.stringify(items.map((item) => ({
    title: item.title,
    repoName: item.repoName,
    repoUrl: item.repoUrl,
    htmlEntryPath: item.htmlEntryPath || item.htmlFileName,
    audioEntryPath: item.audioEntryPath || item.audioFileName,
    audioDurationMs: item.audioDurationMs || null,
  })));
  const pageTurnSoundPayload = JSON.stringify(String(pageTurnSoundEntryPath || ''));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>README HTML Carousel</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #000;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #frame-stage {
      position: fixed;
      inset: 0;
      background: #fff;
    }
    #start-button {
      appearance: none;
      border: 0;
      padding: 14px 28px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.92);
      color: #111;
      font-size: 18px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 10;
    }
    #start-button:hover {
      opacity: 0.92;
      transform: translateY(-1px);
    }
    iframe {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      border: 0;
      background: #fff;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }
    iframe.active {
      opacity: 1;
      pointer-events: auto;
    }
    audio {
      position: fixed;
      width: 0;
      height: 0;
      opacity: 0;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <button id="start-button" type="button">开始播放</button>
  <div id="frame-stage">
    <iframe id="frame-a" class="active" title="README HTML Preview A"></iframe>
    <iframe id="frame-b" title="README HTML Preview B"></iframe>
  </div>
  <audio id="audio" preload="auto"></audio>
  <script>
    const items = ${payload};
    const pageTurnSoundSrc = ${pageTurnSoundPayload};
    const FOOTER_FONT_SIZE = ${repoFooterFontSize};
    const frames = [
      document.getElementById('frame-a'),
      document.getElementById('frame-b'),
    ];
    const audio = document.getElementById('audio');
    const startButton = document.getElementById('start-button');
    const pageTurnSfx = pageTurnSoundSrc ? new Audio(pageTurnSoundSrc) : null;

    let currentIndex = 0;
    let frameLoadToken = 0;
    let fallbackTimer = null;
    let narrationTimer = null;
    let started = false;
    let activeFrameIndex = 0;

    if (pageTurnSfx) {
      pageTurnSfx.preload = 'auto';
      pageTurnSfx.volume = 0.2;
    }

    function injectFooterFontSize(frame) {
      try {
        var doc = frame.contentDocument;
        if (doc && doc.head) {
          var style = doc.createElement('style');
          style.textContent = '.repo-footer, .repo-footer * { font-size: ' + FOOTER_FONT_SIZE + 'px !important; }';
          doc.head.appendChild(style);
        }
      } catch (e) {
        // cross-origin iframe, ignore
      }
    }

    function clearFallbackTimer() {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    }

    function clearNarrationTimer() {
      if (narrationTimer) {
        clearTimeout(narrationTimer);
        narrationTimer = null;
      }
    }

    function getFallbackDelay(item) {
      const duration = Number(item.audioDurationMs);
      if (Number.isFinite(duration) && duration > 0) {
        return duration + (pageTurnSfx ? 360 : 240);
      }
      return 3200;
    }

    function stopAudio() {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    function emitCarouselEvent(name, detail = {}) {
      window.dispatchEvent(new CustomEvent('github-scout:' + name, { detail }));
    }

    function playPageTurnSound() {
      if (!pageTurnSfx) return;

      try {
        pageTurnSfx.pause();
        pageTurnSfx.currentTime = 0;
        const playback = pageTurnSfx.play();
        if (playback && typeof playback.catch === 'function') {
          playback.catch(() => {});
        }
      } catch (error) {
        // Ignore page turn sound failures and keep the carousel running.
      }
    }

    function getActiveFrame() {
      return frames[activeFrameIndex];
    }

    function getStandbyFrame() {
      return frames[(activeFrameIndex + 1) % frames.length];
    }

    function showFrame(frame) {
      frames.forEach((candidate) => {
        candidate.classList.toggle('active', candidate === frame);
      });
      activeFrameIndex = frames.indexOf(frame);
      injectFooterFontSize(frame);
    }

    function advanceToNext() {
      clearFallbackTimer();
      clearNarrationTimer();
      stopAudio();
      if (currentIndex >= items.length - 1) {
        emitCarouselEvent('carousel-complete', {
          currentIndex,
          total: items.length,
          item: items[currentIndex] || null,
        });
        return;
      }
      currentIndex += 1;
      bindCurrentItem();
    }

    function scheduleFallbackAdvance(item) {
      clearFallbackTimer();
      fallbackTimer = setTimeout(() => {
        advanceToNext();
      }, getFallbackDelay(item));
    }

    async function playCurrentAudio(item, token) {
      try {
        await audio.play();
      } catch (error) {
        if (token === frameLoadToken) {
          scheduleFallbackAdvance(item);
        }
      }
    }

    function waitForRecorderOrTimeout(callback) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('github-scout:recorder-started', finish);
        window.removeEventListener('github-scout:recorder-skipped', finish);
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(finish, 1200);
      window.addEventListener('github-scout:recorder-started', finish, { once: true });
      window.addEventListener('github-scout:recorder-skipped', finish, { once: true });
    }

    function afterFrameReady(item, token, frame) {
      if (token !== frameLoadToken) return;

      showFrame(frame);
      stopAudio();
      audio.src = item.audioEntryPath;
      audio.load();
      emitCarouselEvent('page-change', {
        currentIndex,
        total: items.length,
        item,
      });

      const startPagePlayback = () => {
        if (token !== frameLoadToken) return;
        playPageTurnSound();
        scheduleFallbackAdvance(item);
        narrationTimer = setTimeout(() => {
          if (token !== frameLoadToken) return;
          playCurrentAudio(item, token);
        }, pageTurnSfx ? 120 : 0);
      };

      if (currentIndex === 0) {
        waitForRecorderOrTimeout(startPagePlayback);
      } else {
        startPagePlayback();
      }
    }

    function bindCurrentItem() {
      clearFallbackTimer();
      clearNarrationTimer();
      if (!started) return;
      const item = items[currentIndex];
      const token = ++frameLoadToken;
      const targetFrame = currentIndex === 0 ? getActiveFrame() : getStandbyFrame();

      targetFrame.onload = () => {
        targetFrame.onload = null;
        afterFrameReady(item, token, targetFrame);
      };

      targetFrame.src = item.htmlEntryPath;
    }

    audio.addEventListener('ended', () => {
      advanceToNext();
    });

    audio.addEventListener('error', () => {
      const item = items[currentIndex];
      if (item) {
        scheduleFallbackAdvance(item);
      }
    });

    startButton.addEventListener('click', () => {
      if (started || items.length === 0) return;
      started = true;
      emitCarouselEvent('carousel-start', {
        currentIndex,
        total: items.length,
        item: items[currentIndex] || null,
      });
      startButton.remove();
      bindCurrentItem();
    });
  </script>
</body>
</html>`;
}

function buildReadmeResultSummary({
  successItems,
  failures,
  outputDir,
  entryHtmlPath,
  aiModel,
  ttsFormat,
}) {
  const lines = [
    '## 处理摘要',
    '',
    `- 成功生成: ${successItems.length} 个仓库`,
    `- 失败数量: ${failures.length} 个仓库`,
    `- AI 模型: ${aiModel || '未知'}`,
    `- TTS 格式: ${ttsFormat || '未知'}`,
    `- 输出目录: ${outputDir}`,
    `- 浏览器入口: ${entryHtmlPath}`,
    '',
  ];

  if (successItems.length > 0) {
    lines.push('## 已生成仓库');
    successItems.forEach((item) => {
      const imageSuffix = item.imageCount > 0 ? `（图片 ${item.imageCount} 张）` : '';
      lines.push(`- ${item.repoName}${imageSuffix}`);
    });
    lines.push('');
  }

  if (failures.length > 0) {
    lines.push('## 失败列表');
    failures.forEach((failure) => {
      lines.push(`- ${failure.repoName}: ${failure.reason}`);
    });
  }

  return lines.join('\n');
}

/*
function trimReadmeContent(content, maxChars = 20000) {
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false };
  }

  return {
    content: `${normalized.slice(0, maxChars)}\n\n[内容过长，已截断展示]`,
    truncated: true,
  };
}

async function fetchRepoReadme(repoName, token) {
  const [owner, repo] = String(repoName || '').split('/');
  if (!owner || !repo) {
    return { ok: false, message: '仓库名格式无效' };
  }

  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  const res = await httpsGet(endpoint, buildGitHubHeaders(token));

  if (res.statusCode !== 200) {
    const parsed = parseJsonSafely(res.data);
    return {
      ok: false,
      message: parsed?.message || `HTTP ${res.statusCode}`,
    };
  }

  const parsed = parseJsonSafely(res.data);
  if (!parsed) {
    return { ok: false, message: 'README 响应解析失败' };
  }

  let content = '';
  if (parsed.content && parsed.encoding === 'base64') {
    content = decodeBase64Content(parsed.content);
  } else if (parsed.download_url) {
    const rawRes = await httpsGet(parsed.download_url, { 'User-Agent': 'github-scout-app' });
    if (rawRes.statusCode !== 200) {
      return { ok: false, message: `README 下载失败 (HTTP ${rawRes.statusCode})` };
    }
    content = rawRes.data;
  }

  if (!String(content || '').trim()) {
    return { ok: false, message: 'README 为空' };
  }

  const trimmed = trimReadmeContent(content);
  return {
    ok: true,
    content: trimmed.content,
    truncated: trimmed.truncated,
    path: parsed.path || 'README.md',
    htmlUrl: parsed.html_url || '',
  };
}

*/

function trimReadmeContent(content, maxChars = 20000) {
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false };
  }

  return {
    content: `${normalized.slice(0, maxChars)}\n\n[Content truncated for display]`,
    truncated: true,
  };
}

async function fetchRepoReadme(repoName, token) {
  const [owner, repo] = String(repoName || '').split('/');
  if (!owner || !repo) {
    return { ok: false, message: 'Invalid repository name' };
  }

  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  const res = await httpsGet(endpoint, buildGitHubHeaders(token));

  if (res.statusCode !== 200) {
    const parsed = parseJsonSafely(res.data);
    return {
      ok: false,
      message: parsed?.message || `HTTP ${res.statusCode}`,
    };
  }

  const parsed = parseJsonSafely(res.data);
  if (!parsed) {
    return { ok: false, message: 'Failed to parse README response' };
  }

  let content = '';
  if (parsed.content && parsed.encoding === 'base64') {
    content = decodeBase64Content(parsed.content);
  } else if (parsed.download_url) {
    const rawRes = await httpsGet(parsed.download_url, { 'User-Agent': 'github-scout-app' });
    if (rawRes.statusCode !== 200) {
      return { ok: false, message: `README download failed (HTTP ${rawRes.statusCode})` };
    }
    content = rawRes.data;
  }

  if (!String(content || '').trim()) {
    return { ok: false, message: 'README is empty' };
  }

  const trimmed = trimReadmeContent(content);
  return {
    ok: true,
    content: trimmed.content,
    truncated: trimmed.truncated,
    path: parsed.path || 'README.md',
    htmlUrl: parsed.html_url || '',
  };
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

/*
async function handleFetchSelectedReadmes(repos = []) {
  const selectedRepos = Array.isArray(repos)
    ? repos.filter(repo => repo?.name)
    : [];

  if (selectedRepos.length === 0) {
    return {
      ok: false,
      title: 'README 输出',
      errorLabel: '抓取失败',
      message: '请先勾选至少一个仓库',
    };
  }

  const auth = loadAuth();
  const token = auth?.accessToken;
  const sections = ['## README 抓取结果', ''];
  const failures = [];
  const repoUrlMap = {};
  let successCount = 0;

  log(`[README] 开始抓取 ${selectedRepos.length} 个仓库的 README...`, 'info');

  for (let i = 0; i < selectedRepos.length; i++) {
    const repo = selectedRepos[i];
    const repoUrl = repo.url || `https://github.com/${repo.name}`;
    repoUrlMap[repo.name] = repoUrl;
    log(`[README] [${i + 1}/${selectedRepos.length}] ${repo.name}`, 'info');

    try {
      const result = await fetchRepoReadme(repo.name, token);
      if (!result.ok) {
        failures.push(`${repo.name}: ${result.message}`);
        log(`[README] ${repo.name} 抓取失败: ${result.message}`, 'error');
        continue;
      }

      successCount += 1;
      log(`[README] ${repo.name} 抓取成功${result.truncated ? ' (已截断)' : ''}`, 'success');

      sections.push(`### ${repo.name}`);
      sections.push(`仓库链接: ${repoUrl}`);
      sections.push(`README 文件: ${result.path}`);
      if (result.truncated) {
        sections.push('提示: 内容较长，当前仅展示前 20000 个字符。');
      }
      sections.push('');
      sections.push(result.content);
      sections.push('');
    } catch (e) {
      failures.push(`${repo.name}: ${e.message}`);
      log(`[README] ${repo.name} 抓取失败: ${e.message}`, 'error');
    }
  }

  if (failures.length > 0) {
    sections.push('## 抓取失败');
    failures.forEach(item => sections.push(`- ${item}`));
  }

  if (successCount === 0) {
    return {
      ok: false,
      title: 'README 输出',
      errorLabel: '抓取失败',
      message: failures[0] || '没有抓取到 README 内容',
      repoUrlMap,
    };
  }

  sections.splice(1, 0, `成功抓取 ${successCount} 个仓库的 README。`);
  if (failures.length > 0) {
    sections.splice(2, 0, `失败 ${failures.length} 个仓库，详情见下方。`);
  }

  return {
    ok: true,
    title: 'README 输出',
    model: `README x${successCount}`,
    content: sections.join('\n'),
    repoUrlMap,
  };
}

*/

function buildReadmeHtmlUserPrompt(repo, repoUrl, readmeResult) {
  const template = resolvePrompt('readmeHtmlUserPrompt',
    '请基于以下 GitHub 仓库 README 生成完整 HTML。\n仓库名：\${repo.name}\n仓库链接：\${repoUrl}\nStars：\${repo.stars}\nForks：\${repo.forks}\nREADME 文件：\${readmeResult.path}\n\nREADME 内容：\n\${readmeResult.content}');
  return template
    .replace(/\$\{repo\.name\}/g, repo.name)
    .replace(/\$\{repoUrl\}/g, repoUrl)
    .replace(/\$\{repo\.stars\}/g, String(repo.stars || 0))
    .replace(/\$\{repo\.forks\}/g, String(repo.forks || 0))
    .replace(/\$\{readmeResult\.path\}/g, readmeResult.path)
    .replace(/\$\{readmeResult\.content\}/g, readmeResult.content);
}

function buildReadmeHtmlRetryUserPrompt(repo, repoUrl, readmeResult, previousContent = '', previousError = '') {
  const preview = sanitizeAiContent(String(previousContent || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
  const errorMessage = sanitizeText(previousError);

  const baseUserPrompt = buildReadmeHtmlUserPrompt(repo, repoUrl, readmeResult);

  const template = resolvePrompt('readmeHtmlRetryUserPrompt',
    '\${baseUserPrompt}\n\n上一次返回未通过程序提取，请重新生成一次完整 HTML。\n\${errorLine}\n\${previewLine}\n\n强制要求：\n1. 只输出一个代码块，不要输出解释、说明、前言或结尾。\n2. 优先使用三单引号代码块，格式必须是：\n\'\'\'html\n<!DOCTYPE html>\n...\n\'\'\'\n3. 如果你没有使用三单引号，至少也要直接输出完整 HTML 文档本体，不要夹杂任何额外文字。\n4. HTML 必须完整，包含 <!DOCTYPE html>。');
  return template
    .replace(/\$\{baseUserPrompt\}/g, baseUserPrompt)
    .replace(/\$\{errorLine\}/g, errorMessage ? `上一次问题：${errorMessage}` : '')
    .replace(/\$\{previewLine\}/g, preview ? `上一次返回预览：${preview}` : '');
}

async function requestReadmeHtmlWithRetry({
  repo,
  repoUrl,
  readmeResult,
  aiConfig,
  htmlPrompt,
}) {
  const requestHtml = async (userContent, temperature) => callAiChat(aiConfig, [
    { role: 'system', content: htmlPrompt },
    {
      role: 'user',
      content: userContent,
    },
  ], {
    timeout: 300000,
    maxTokens: 8192,
    temperature,
  });

  const firstResult = await requestHtml(
    buildReadmeHtmlUserPrompt(repo, repoUrl, readmeResult),
    0.4,
  );
  const firstExtractedHtml = firstResult.ok ? extractHtmlFromAiResponse(firstResult.content) : '';

  if (firstResult.ok && firstExtractedHtml) {
    return {
      ...firstResult,
      extractedHtml: firstExtractedHtml,
      retried: false,
    };
  }

  const retryReason = firstResult.ok
    ? 'AI 返回内容中未提取到有效 HTML'
    : firstResult.message;
  log(`[README] ${repo.name} HTML 生成异常，正在自动重试 1 次: ${retryReason}`, 'warn');

  const retryResult = await requestHtml(
    buildReadmeHtmlRetryUserPrompt(repo, repoUrl, readmeResult, firstResult.content, retryReason),
    0.2,
  );
  const retryExtractedHtml = retryResult.ok ? extractHtmlFromAiResponse(retryResult.content) : '';

  if (retryResult.ok && retryExtractedHtml) {
    log(`[README] ${repo.name} HTML 重试生成成功`, 'success');
    return {
      ...retryResult,
      extractedHtml: retryExtractedHtml,
      retried: true,
    };
  }

  if (!retryResult.ok) {
    return retryResult;
  }

  const preview = sanitizeAiContent(String(retryResult.content || firstResult.content || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return {
    ok: false,
    message: `HTML 提取失败：已自动重试 1 次，仍未找到有效的 HTML 内容${preview ? `，预览: ${preview}` : ''}`,
    model: retryResult.model || firstResult.model || aiConfig.model,
    content: retryResult.content || firstResult.content || '',
  };
}

async function processSelectedReadmeRepo({
  repo,
  index,
  total,
  token,
  aiConfig,
  htmlPrompt,
  narrationSystemPrompt,
  ttsConfig,
  outputDir,
  repoImages,
}) {
  const repoUrl = repo.url || `https://github.com/${repo.name}`;
  const repoDirName = sanitizeRepoFileName(repo.name, index);
  const repoDirPath = path.join(outputDir, repoDirName);
  const selectedImagePaths = Array.isArray(repoImages?.[repo.name]) ? repoImages[repo.name] : [];

  ensureDir(repoDirPath);
  log(`[README] [${index + 1}/${total}] 抓取 README: ${repo.name}`, 'info');

  try {
    const readmeResult = await fetchRepoReadme(repo.name, token);
    if (!readmeResult.ok) {
      throw new Error(`README 抓取失败: ${readmeResult.message}`);
    }

    log(`[README] ${repo.name} README 抓取成功${readmeResult.truncated ? ' (已截断)' : ''}`, 'success');
    log(`[README] ${repo.name} 开始生成 HTML`, 'info');

    const htmlResult = await requestReadmeHtmlWithRetry({
      repo,
      repoUrl,
      readmeResult,
      aiConfig,
      htmlPrompt,
    });

    if (!htmlResult.ok) {
      throw new Error(`HTML 生成失败: ${htmlResult.message}`);
    }

    const extractedHtml = String(htmlResult.extractedHtml || '').trim();

    const imageCopyResult = copyRepoImagesToOutput(selectedImagePaths, repoDirPath);
    if (imageCopyResult.imageCount > 0) {
      log(`[README] ${repo.name} 已复制 ${imageCopyResult.imageCount} 张图片`, 'success');
    }
    if (imageCopyResult.skippedPaths.length > 0) {
      log(`[README] ${repo.name} 有 ${imageCopyResult.skippedPaths.length} 张图片复制失败，已跳过`, 'warn');
    }

    const htmlFileName = 'index.html';
    const htmlFilePath = path.join(repoDirPath, htmlFileName);
    const htmlEntryPath = `${repoDirName}/${htmlFileName}`;
    const htmlForNarration = extractedHtml.trim();
    log(`[README] ${repo.name} HTML 已保存: ${htmlEntryPath}`, 'success');

    log(`[README] ${repo.name} 开始生成解说词`, 'info');
    const narrationResult = await callAiChat(aiConfig, [
      { role: 'system', content: narrationSystemPrompt },
      {
        role: 'user',
        content: buildReadmeNarrationPrompt(repo, htmlForNarration),
      },
    ], {
      timeout: 180000,
      maxTokens: 800,
      temperature: 0.5,
    });

    if (!narrationResult.ok) {
      throw new Error(`解说词生成失败: ${narrationResult.message}`);
    }

    const narrationText = sanitizeAiContent(narrationResult.content).replace(/\s+/g, ' ').trim();
    if (!narrationText) {
      throw new Error('解说词生成失败: AI 返回内容为空');
    }

    log(`[README] ${repo.name} 开始生成 MiniMax TTS`, 'info');
    const audioResult = await synthesizeTtsToCache(narrationText, ttsConfig);
    const audioExtension = path.extname(audioResult.audioPath) || `.${ttsConfig.format || 'mp3'}`;
    const audioFileName = `narration${audioExtension}`;
    const audioFilePath = path.join(repoDirPath, audioFileName);
    const audioEntryPath = `${repoDirName}/${audioFileName}`;
    fs.copyFileSync(audioResult.audioPath, audioFilePath);
    const finalHtml = injectLocalImageManifestIntoHtml(
      extractedHtml,
      imageCopyResult.images,
      audioResult.durationMs,
    );
    fs.writeFileSync(htmlFilePath, finalHtml.trim(), 'utf8');
    log(`[README] ${repo.name} HTML 宸蹭繚瀛? ${htmlEntryPath}`, 'success');
    log(`[README] ${repo.name} TTS 已保存: ${audioEntryPath}${audioResult.cached ? ' (复用缓存)' : ''}`, 'success');

    return {
      ok: true,
      order: index,
      repoUrl,
      aiModel: htmlResult.model || narrationResult.model || aiConfig.model,
      item: {
        title: repo.name,
        repoName: repo.name,
        repoUrl,
        repoDirName,
        repoDirPath,
        htmlFileName,
        htmlEntryPath,
        audioFileName,
        audioEntryPath,
        audioDurationMs: audioResult.durationMs || null,
        imageCount: imageCopyResult.imageCount,
        narrationText,
        htmlPath: htmlFilePath,
        audioPath: audioFilePath,
        readmePath: readmeResult.path,
      },
    };
  } catch (error) {
    log(`[README] ${repo.name} 处理失败: ${error.message}`, 'error');
    return {
      ok: false,
      order: index,
      repoUrl,
      failure: {
        repoName: repo.name,
        reason: error.message,
      },
    };
  }
}

async function handleFetchSelectedReadmes(payload = {}) {
  const selectedRepos = Array.isArray(payload?.repos)
    ? payload.repos.filter((repo) => repo?.name)
    : Array.isArray(payload)
      ? payload.filter((repo) => repo?.name)
      : [];
  const aiConfig = payload?.aiConfig || null;
  const repoImages = payload?.repoImages && typeof payload.repoImages === 'object'
    ? payload.repoImages
    : {};

  if (selectedRepos.length === 0) {
    return {
      ok: false,
      title: 'README HTML 轮播输出',
      errorLabel: '生成失败',
      message: '请先勾选至少一个仓库',
      failures: [],
    };
  }

  if (!aiConfig?.baseUrl || !aiConfig?.apiKey || !aiConfig?.model) {
    return {
      ok: false,
      title: 'README HTML 轮播输出',
      errorLabel: '生成失败',
      message: '缺少可用的 AI 配置，请先完成 AI 连接选择',
      failures: [],
    };
  }

  const presentationConfig = loadPresentationConfig();
  const ttsConfig = presentationConfig.tts;
  const footerFontSize = presentationConfig.repoFooterFontSize || 14;
  if (!ttsConfig?.apiKey) {
    return {
      ok: false,
      title: 'README HTML 轮播输出',
      errorLabel: '生成失败',
      message: '缺少 MiniMax TTS 配置，请先在固定播放器面板中填写并保存 API Key',
      failures: [],
    };
  }

  const htmlPrompt = loadReadmeHtmlPrompt();
  const narrationSystemPrompt = resolvePrompt('narrationSystemPrompt', '你是一位专业的中文讲解文案助手，只输出适合直接朗读的中文解说词正文。');
  const auth = loadAuth();
  const token = auth?.accessToken;
  const pipelineNarrationSystemPrompt = resolvePrompt('narrationSystemPrompt', '你是一位专业的中文讲解文案助手，只输出适合直接朗读的中文解说词正文。');
  const pipelineRunStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pipelineOutputDir = path.join(README_CAROUSEL_RUNS_DIR, pipelineRunStamp);
  const pipelineManifestPath = path.join(pipelineOutputDir, 'manifest.json');
  const pipelineEntryHtmlPath = path.join(pipelineOutputDir, 'index.html');
  const pipelineUsedAiModels = new Set();

  ensureDir(pipelineOutputDir);
  log(`[README] 开始生成 README HTML 轮播，共 ${selectedRepos.length} 个仓库`, 'info');

  const pipelineRepoUrlMap = Object.fromEntries(selectedRepos.map((repo) => [
    repo.name,
    repo.url || `https://github.com/${repo.name}`,
  ]));

  const pipelineResults = await mapWithConcurrency(
    selectedRepos,
    Math.min(README_PIPELINE_CONCURRENCY, selectedRepos.length),
    (repo, index) => processSelectedReadmeRepo({
      repo,
      index,
      total: selectedRepos.length,
      token,
      aiConfig,
      htmlPrompt,
      narrationSystemPrompt: pipelineNarrationSystemPrompt,
      ttsConfig,
      outputDir: pipelineOutputDir,
      repoImages,
    }),
  );

  const pipelineSuccessItems = pipelineResults
    .filter((result) => result?.ok && result.item)
    .sort((a, b) => a.order - b.order)
    .map((result) => {
      if (result.aiModel) {
        pipelineUsedAiModels.add(result.aiModel);
      }
      return result.item;
    });

  const pipelineFailures = pipelineResults
    .filter((result) => result && !result.ok && result.failure)
    .sort((a, b) => a.order - b.order)
    .map((result) => result.failure);

  if (pipelineSuccessItems.length === 0) {
    return {
      ok: false,
      title: 'README HTML 轮播输出',
      errorLabel: '生成失败',
      message: pipelineFailures[0]?.reason || '没有成功生成任何 HTML 文件',
      repoUrlMap: pipelineRepoUrlMap,
      failures: pipelineFailures,
      successCount: 0,
      failureCount: pipelineFailures.length,
      outputDir: pipelineOutputDir,
      entryHtmlPath: '',
    };
  }

  const pipelineAiModelSummary = pipelineUsedAiModels.size > 0
    ? Array.from(pipelineUsedAiModels).join(', ')
    : aiConfig.model;

  const introText = buildGitHubBriefingWelcomeText();
  const outroText = GITHUB_BRIEFING_OUTRO_TEXT;

  log('[README] 开始生成首页欢迎语', 'info');
  const introItem = await createBriefingNarrationCardItem({
    outputDir: pipelineOutputDir,
    dirName: '00-opening',
    segmentType: 'intro',
    title: 'GitHub 早报',
    ttsText: introText,
    kicker: '今日播报',
    body: introText,
    ttsConfig,
  });
  log(`[README] 首页欢迎语已生成: ${introItem.htmlEntryPath}`, 'success');

  log('[README] 开始合并结束语到最后一页', 'info');
  const mergedLastItem = await mergeBriefingOutroIntoLastItem(pipelineSuccessItems, outroText, ttsConfig);
  if (mergedLastItem?.htmlEntryPath) {
    log(`[README] 结束语已合并到最后一页: ${mergedLastItem.htmlEntryPath}`, 'success');
  }
  const pipelineCarouselItems = [introItem, ...pipelineSuccessItems];

  const pipelineManifest = {
    generatedAt: new Date().toISOString(),
    aiModel: pipelineAiModelSummary,
    ttsModel: ttsConfig.model,
    ttsFormat: ttsConfig.format,
    items: pipelineCarouselItems.map((item) => ({
      title: item.title,
      repoName: item.repoName,
      repoUrl: item.repoUrl,
      segmentType: item.segmentType || 'repo',
      repoDirName: item.repoDirName,
      htmlFileName: item.htmlFileName,
      htmlPath: item.htmlPath || '',
      htmlEntryPath: item.htmlEntryPath,
      audioFileName: item.audioFileName,
      audioPath: item.audioPath || '',
      audioEntryPath: item.audioEntryPath,
      audioDurationMs: item.audioDurationMs || null,
      ttsText: item.narrationText || '',
      imageCount: item.imageCount || 0,
      readmePath: item.readmePath,
    })),
    failures: pipelineFailures,
  };

  const pipelinePageTurnSoundEntryPath = copyPageTurnSoundToOutput(pipelineOutputDir);
  copyFontToOutput(pipelineOutputDir);
  if (pipelinePageTurnSoundEntryPath) {
    log(`[README] 已复制切页音效: ${pipelinePageTurnSoundEntryPath}`, 'success');
  } else {
    log(`[README] 未找到切页音效文件: ${PAGE_TURN_SOUND_FILE_NAME}，轮播入口将不播放切页音`, 'warn');
  }

  fs.writeFileSync(pipelineManifestPath, JSON.stringify(pipelineManifest, null, 2), 'utf8');
  fs.writeFileSync(
    pipelineEntryHtmlPath,
    buildCarouselIndexHtml(pipelineCarouselItems, pipelinePageTurnSoundEntryPath, footerFontSize),
    'utf8',
  );
  log(`[README] 轮播入口已生成: ${pipelineEntryHtmlPath}`, 'success');

  return {
    ok: true,
    title: 'README HTML 轮播输出',
    model: `${pipelineAiModelSummary} / ${ttsConfig.model}`,
    message: `成功生成 ${pipelineSuccessItems.length} 个 HTML 文件`,
    content: buildReadmeResultSummary({
      successItems: pipelineSuccessItems,
      failures: pipelineFailures,
      outputDir: pipelineOutputDir,
      entryHtmlPath: pipelineEntryHtmlPath,
      aiModel: pipelineAiModelSummary,
      ttsFormat: ttsConfig.format,
    }),
    repoUrlMap: pipelineRepoUrlMap,
    failures: pipelineFailures,
    successCount: pipelineSuccessItems.length,
    failureCount: pipelineFailures.length,
    outputDir: pipelineOutputDir,
    entryHtmlPath: pipelineEntryHtmlPath,
    manifestPath: pipelineManifestPath,
  };
  const repoUrlMap = {};
  const failures = [];
  const successItems = [];
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(README_CAROUSEL_RUNS_DIR, runStamp);
  const manifestPath = path.join(outputDir, 'manifest.json');
  const entryHtmlPath = path.join(outputDir, 'index.html');
  let lastAiModel = aiConfig.model;

  ensureDir(outputDir);
  log(`[README] 开始生成 README HTML 轮播，共 ${selectedRepos.length} 个仓库`, 'info');

  for (let index = 0; index < selectedRepos.length; index += 1) {
    const repo = selectedRepos[index];
    const repoUrl = repo.url || `https://github.com/${repo.name}`;
    const safeBaseName = sanitizeRepoFileName(repo.name, index);
    const repoDirName = safeBaseName;
    const repoDirPath = path.join(outputDir, repoDirName);
    const selectedImagePaths = Array.isArray(repoImages[repo.name]) ? repoImages[repo.name] : [];
    repoUrlMap[repo.name] = repoUrl;

    ensureDir(repoDirPath);
    log(`[README] [${index + 1}/${selectedRepos.length}] 抓取 README: ${repo.name}`, 'info');

    try {
      const readmeResult = await fetchRepoReadme(repo.name, token);
      if (!readmeResult.ok) {
        throw new Error(`README 抓取失败: ${readmeResult.message}`);
      }

      log(`[README] ${repo.name} README 抓取成功${readmeResult.truncated ? ' (已截断)' : ''}`, 'success');
      log(`[README] ${repo.name} 开始生成 HTML`, 'info');

      const htmlResult = await requestReadmeHtmlWithRetry({
        repo,
        repoUrl,
        readmeResult,
        aiConfig,
        htmlPrompt,
      });

      if (!htmlResult.ok) {
        throw new Error(`HTML 生成失败: ${htmlResult.message}`);
      }

      lastAiModel = htmlResult.model || lastAiModel;
      const extractedHtml = String(htmlResult.extractedHtml || '').trim();

      const imageCopyResult = copyRepoImagesToOutput(selectedImagePaths, repoDirPath);
      if (imageCopyResult.imageCount > 0) {
        log(`[README] ${repo.name} 已复制 ${imageCopyResult.imageCount} 张图片`, 'success');
      }
      if (imageCopyResult.skippedPaths.length > 0) {
        log(`[README] ${repo.name} 有 ${imageCopyResult.skippedPaths.length} 张图片复制失败，已跳过`, 'warn');
      }

      const htmlFileName = 'index.html';
      const htmlFilePath = path.join(repoDirPath, htmlFileName);
      const htmlEntryPath = `${repoDirName}/${htmlFileName}`;
      const htmlForNarration = extractedHtml.trim();
      log(`[README] ${repo.name} HTML 已保存: ${htmlEntryPath}`, 'success');

      log(`[README] ${repo.name} 开始生成解说词`, 'info');
      const narrationResult = await callAiChat(aiConfig, [
        { role: 'system', content: narrationSystemPrompt },
        {
          role: 'user',
          content: buildReadmeNarrationPrompt(repo, htmlForNarration),
        },
      ], {
        timeout: 180000,
        maxTokens: 800,
        temperature: 0.5,
      });

      if (!narrationResult.ok) {
        throw new Error(`解说词生成失败: ${narrationResult.message}`);
      }

      const narrationText = sanitizeAiContent(narrationResult.content).replace(/\s+/g, ' ').trim();
      if (!narrationText) {
        throw new Error('解说词生成失败: AI 返回内容为空');
      }

      log(`[README] ${repo.name} 开始生成 MiniMax TTS`, 'info');
      const audioResult = await synthesizeTtsToCache(narrationText, ttsConfig);
      const audioExtension = path.extname(audioResult.audioPath) || `.${ttsConfig.format || 'mp3'}`;
      const audioFileName = `narration${audioExtension}`;
      const audioFilePath = path.join(repoDirPath, audioFileName);
      const audioEntryPath = `${repoDirName}/${audioFileName}`;
      fs.copyFileSync(audioResult.audioPath, audioFilePath);
      const finalHtml = injectLocalImageManifestIntoHtml(
        extractedHtml,
        imageCopyResult.images,
        audioResult.durationMs,
      );
      fs.writeFileSync(htmlFilePath, finalHtml.trim(), 'utf8');
      log(`[README] ${repo.name} HTML 宸蹭繚瀛? ${htmlEntryPath}`, 'success');
      log(`[README] ${repo.name} TTS 已保存: ${audioEntryPath}${audioResult.cached ? ' (复用缓存)' : ''}`, 'success');

      successItems.push({
        title: repo.name,
        repoName: repo.name,
        repoUrl,
        repoDirName,
        repoDirPath,
        htmlFileName,
        htmlEntryPath,
        audioFileName,
        audioEntryPath,
        audioDurationMs: audioResult.durationMs || null,
        imageCount: imageCopyResult.imageCount,
        narrationText,
        htmlPath: htmlFilePath,
        audioPath: audioFilePath,
        readmePath: readmeResult.path,
      });
    } catch (error) {
      failures.push({
        repoName: repo.name,
        reason: error.message,
      });
      log(`[README] ${repo.name} 处理失败: ${error.message}`, 'error');
    }
  }

  if (successItems.length === 0) {
    return {
      ok: false,
      title: 'README HTML 轮播输出',
      errorLabel: '生成失败',
      message: failures[0]?.reason || '没有成功生成任何 HTML 文件',
      repoUrlMap,
      failures,
      successCount: 0,
      failureCount: failures.length,
      outputDir,
      entryHtmlPath: '',
    };
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    aiModel: lastAiModel,
    ttsModel: ttsConfig.model,
    ttsFormat: ttsConfig.format,
    items: successItems.map((item) => ({
      title: item.title,
      repoName: item.repoName,
      repoUrl: item.repoUrl,
      repoDirName: item.repoDirName,
      htmlFileName: item.htmlFileName,
      htmlEntryPath: item.htmlEntryPath,
      audioFileName: item.audioFileName,
      audioEntryPath: item.audioEntryPath,
      audioDurationMs: item.audioDurationMs || null,
      imageCount: item.imageCount || 0,
      readmePath: item.readmePath,
    })),
    failures,
  };

  const pageTurnSoundEntryPath = copyPageTurnSoundToOutput(outputDir);
  copyFontToOutput(outputDir);
  if (pageTurnSoundEntryPath) {
    log(`[README] 已复制切页音效: ${pageTurnSoundEntryPath}`, 'success');
  } else {
    log(`[README] 未找到切页音效文件: ${PAGE_TURN_SOUND_FILE_NAME}，轮播入口将不播放切页音`, 'warn');
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(entryHtmlPath, buildCarouselIndexHtml(successItems, pageTurnSoundEntryPath, footerFontSize), 'utf8');
  log(`[README] 轮播入口已生成: ${entryHtmlPath}`, 'success');

  return {
    ok: true,
    title: 'README HTML 轮播输出',
    model: `${lastAiModel || aiConfig.model} / ${ttsConfig.model}`,
    message: `成功生成 ${successItems.length} 个 HTML 文件`,
    content: buildReadmeResultSummary({
      successItems,
      failures,
      outputDir,
      entryHtmlPath,
      aiModel: lastAiModel || aiConfig.model,
      ttsFormat: ttsConfig.format,
    }),
    repoUrlMap,
    failures,
    successCount: successItems.length,
    failureCount: failures.length,
    outputDir,
    entryHtmlPath,
    manifestPath,
  };
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

function getRepoSnapshotKey(name, updated = '') {
  return `${sanitizeText(name)}::${sanitizeText(updated)}`;
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
    const updated = sanitizeText(repo.updated);
    if (!name || !url) continue;

    const tags = [...new Set((repo.tags || []).map(sanitizeTag).filter(Boolean))];
    const description = sanitizeText(repo.description) || 'GitHub开源项目';

    repoMap.set(getRepoSnapshotKey(name, updated), {
      ...repo,
      name,
      url,
      tags,
      description,
      updated,
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
  const serialized = JSON.stringify(sanitizeRepoAnalysisData(data), null, 2);
  // 原子写入：先写临时文件，备份旧文件，再重命名
  const tmp = REPO_ANALYSIS_FILE + '.tmp';
  fs.writeFileSync(tmp, serialized, 'utf8');
  try {
    if (fs.existsSync(REPO_ANALYSIS_FILE)) {
      fs.copyFileSync(REPO_ANALYSIS_FILE, REPO_ANALYSIS_FILE + '.bak');
    }
  } catch (_) { /* backup non-critical */ }
  fs.renameSync(tmp, REPO_ANALYSIS_FILE);
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
  const { systemPrompt } = aiConfig;
  const effectiveSystemPrompt = resolvePrompt('userSystemPrompt', systemPrompt || '');
  const structuredAiConfig = { ...aiConfig };
  const structuredFallbackModel = getStructuredOutputFallbackModel(aiConfig?.baseUrl, aiConfig?.model);
  if (structuredFallbackModel && structuredFallbackModel !== aiConfig.model) {
    structuredAiConfig.model = structuredFallbackModel;
  }

  log('[AI] 准备分析数据...', 'info');
  if (structuredAiConfig.model !== aiConfig.model) {
    log(`[AI] 结构化分析改用 ${structuredAiConfig.model}，避免 ${aiConfig.model} 空正文`, 'info');
  }

  const callAI = (messages, timeout, maxTokens) => callAiChat(aiConfig, messages, {
    timeout,
    maxTokens,
    temperature: 0.7,
  });
  const callStructuredAI = (messages, timeout, maxTokens) => callAiChat(structuredAiConfig, messages, {
    timeout,
    maxTokens,
    temperature: 0,
  });
  const forceChineseOutputInstruction =
    resolvePrompt('forceChineseOutputInstruction', '无论如何都要输出中文。即使输入内容、仓库名、标签、引用材料或上下文中包含英文，也不要改用英文回答。');
  const withForcedChineseOutput = (prompt) =>
    `${String(prompt || '').trim()}\n\n额外要求：${forceChineseOutputInstruction}`;

  // Parse tag analysis response: "name|tag1,tag2|description" per line
  function parseTagAnalysis(content) {
    const tagMap = {};
    const normalizedText = String(content || '')
      .replace(/\r\n/g, '\n')
      .replace(/<think>[\s\S]*?<\/think>/gi, '\n')
      .replace(/```[^\n\r]*\r?\n/g, '\n')
      .replace(/```/g, '\n')
      .replace(/[｜¦]/g, '|');
    const lines = normalizedText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    for (const rawLine of lines) {
      const line = rawLine
        .replace(/^\s*(?:[-*•]+|\d+[.)]|第\s*\d+\s*[项条])\s*/u, '')
        .replace(/\s*\|\s*/g, '|');
      const parts = line.split('|');
      if (parts.length >= 3) {
        const name = parts[0]
          .replace(/^(?:仓库|项目|repo|repository)\s*[:：]\s*/i, '')
          .trim();
        const tags = parts[1]
          .replace(/^(?:标签|tags?)\s*[:：]\s*/i, '')
          .split(/[，,、]/)
          .map(t => t.trim())
          .filter(t => t);
        const description = parts.slice(2)
          .join('|')
          .replace(/^(?:描述|说明|desc(?:ription)?)\s*[:：]\s*/i, '')
          .trim();
        if (name && name.includes('/') && tags.length > 0) {
          tagMap[name] = { tags, description };
        }
      }
    }
    return tagMap;
  }

  const buildChinesePrompt = (prompt) =>
    `${String(prompt || '').trim()}\n\nAdditional requirement: ${forceChineseOutputInstruction}`;
  const structuredOutputGuard = resolvePrompt('structuredOutputGuard', [
    'Structured output only.',
    'Do not output thinking, reasoning, explanations, markdown, code fences, XML, or <think> tags.',
    'Do not output any prose before or after the structured data.',
    'If line format is requested, return exactly one repo per line: owner/repo|tag1,tag2|description.',
  ].join('\n'));
  const withStructuredOutputGuard = (prompt) =>
    `${buildChinesePrompt(prompt)}\n\n${structuredOutputGuard}`;
  const buildTagAnalysisPreview = (content) => buildStructuredPreview(content, 200);
  const runStructuredRepoMappingRequest = async ({
    systemPromptText,
    userContent,
    expectedRepoNames = [],
    retryLabel = 'structured output',
    timeout = 300000,
    maxTokens = 4096,
  }) => {
    const primaryResult = await callStructuredAI([
      { role: 'system', content: withStructuredOutputGuard(systemPromptText) },
      { role: 'user', content: userContent },
    ], timeout, maxTokens);

    if (!primaryResult.ok) {
      return primaryResult;
    }

    let tagMap = parseStructuredRepoTagMap(primaryResult.content, expectedRepoNames);
    if (Object.keys(tagMap).length > 0) {
      return { ...primaryResult, tagMap, retried: false };
    }

    log(`[AI] ${retryLabel}: 结构化输出未命中，正在使用 JSON 重试`, 'warn');

    const retryTemplate = resolvePrompt('structuredOutputRetryPrompt',
      '\${systemPromptText}\n\nRetry mode: return valid JSON only.\nNo prose, no markdown, no code fences, no <think> tags.\nUse this exact schema:\n{"items":[{"name":"owner/repo","tags":["tag1","tag2"],"description":"一句中文描述"}]}\n\${expectedRepoNamesLine}');
    const retryPrompt = retryTemplate
      .replace(/\$\{systemPromptText\}/g, String(systemPromptText || '').trim())
      .replace(/\$\{expectedRepoNamesLine\}/g, expectedRepoNames.length > 0 ? `Allowed repo names: ${expectedRepoNames.join(', ')}` : '')
      .split('\n')
      .filter(line => line.trim())
      .join('\n');

    const retryResult = await callStructuredAI([
      { role: 'system', content: withStructuredOutputGuard(retryPrompt) },
      { role: 'user', content: userContent },
    ], timeout, maxTokens);

    if (!retryResult.ok) {
      return retryResult;
    }

    tagMap = parseStructuredRepoTagMapFromJson(retryResult.content, expectedRepoNames);
    if (Object.keys(tagMap).length === 0) {
      tagMap = parseStructuredRepoTagMap(retryResult.content, expectedRepoNames);
    }

    return {
      ...retryResult,
      tagMap,
      retried: true,
    };
  };

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

    const tagAnalysisPrompt = resolvePrompt('tagAnalysisPrompt',
      `你是一个GitHub项目分析专家。请分析以下仓库，对每个仓库：
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

请简洁回答，使用中文。`);

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
        runStructuredRepoMappingRequest({
          systemPromptText: tagAnalysisPrompt,
          userContent: batchText,
          expectedRepoNames: batch.map((repo) => repo.name),
          retryLabel: `批次 ${Math.floor(batchStart / batchSize) + 1}`,
          timeout: 300000,
          maxTokens: 4096,
        }).then(result => ({ index: batchStart, result }))
      );
    }

    // Wait for all batches to complete
    const results = await Promise.allSettled(batchPromises);
    const tagMap = {};

    for (const entry of results) {
      if (entry.status === 'fulfilled') {
        const { index, result } = entry.value;
        if (result.ok) {
          const batchMap = result.tagMap || {};
          Object.assign(tagMap, batchMap);
          const parsedCount = Object.keys(batchMap).length;
          if (parsedCount === 0) {
            const preview = buildTagAnalysisPreview(result.content);
            log(
              `[AI] 批次 ${Math.floor(index / batchSize) + 1}: 解析 0 个，模型返回格式未匹配${preview ? `，预览: ${preview}` : ''}`,
              'warn',
            );
          } else {
            log(`[AI] 批次 ${Math.floor(index / batchSize) + 1}: 解析 ${parsedCount} 个`, 'success');
          }
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
        const descSupplementPrompt = resolvePrompt('descSupplementPrompt',
          `以下是几个信息不足的GitHub仓库，以及可能相关的历史仓库描述作为参考。请为每个仓库提供1-3个标签和一句话描述。

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

请简洁回答，使用中文。`);

        const descResult = await runStructuredRepoMappingRequest({
          systemPromptText: descSupplementPrompt,
          userContent: refEntries.join('\n\n'),
          expectedRepoNames: meaninglessRepos.map((repo) => repo.name),
          retryLabel: '描述补全',
          timeout: 300000,
        });

        if (descResult.ok) {
          const supplementMap = descResult.tagMap || {};
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

    const existingSnapshotMap = new Map();
    const existingReposByName = new Map();
    saved.repos.forEach(r => {
      existingSnapshotMap.set(getRepoSnapshotKey(r.name, r.updated), r);
      const sameNameRepos = existingReposByName.get(r.name) || [];
      sameNameRepos.push(r);
      existingReposByName.set(r.name, sameNameRepos);
    });

    // Build existing tag set once for normalization (avoid per-call disk reads)
    const existingTagSet = new Set();
    saved.repos.forEach(r => (r.tags || []).forEach(t => existingTagSet.add(t)));

    const today = new Date().toISOString().split('T')[0];
    const finalSnapshotMap = new Map(existingSnapshotMap);

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
      const historicalTags = (existingReposByName.get(repo.name) || [])
        .flatMap(r => r.tags || []);
      const merged = {
        name: repo.name,
        url: repo.url,
        tags: [...new Set([...normalizedTags, ...historicalTags])],
        description: analysis.description,
        stars: repo.stars,
        forks: repo.forks,
        updated: today,
      };

      finalSnapshotMap.set(getRepoSnapshotKey(repo.name, today), merged);
      const nextHistory = (existingReposByName.get(repo.name) || [])
        .filter(r => r.updated !== today);
      nextHistory.push(merged);
      existingReposByName.set(repo.name, nextHistory);
    }

    const mergedRepos = Array.from(finalSnapshotMap.values());
    const finalData = { repos: mergedRepos };
    saveRepoAnalysis(finalData);
    log(`[AI] 已保存 ${mergedRepos.length} 个仓库的分析数据`, 'success');

    // ===== 模块三：总结（当前批次 + 跨期趋势，并发发送） =====
    log('[AI] 正在生成总结...', 'info');

    const currentSummaryPrompt = resolvePrompt('currentSummaryPrompt',
      `你是一个GitHub趋势分析专家。以下是本次爬取的全部仓库数据（含标签、描述、stars、forks、更新时间）。

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

请简洁回答，使用中文。`);

    const validRepos = mergedRepos.filter(r => r.updated === today);
    const currentText = validRepos.map(r =>
      `${r.name} | Tags:${r.tags.join(',')} | 语言:${repos.find(rp => rp.name === r.name)?.language || 'N/A'} | Stars:${r.stars} | Forks:${r.forks} | Updated:${r.updated} | Desc:${r.description}`
    ).join('\n');

    const currentRepoNames = new Set(validRepos.map(r => r.name));
    const currentRepoHistory = mergedRepos
      .filter(r => currentRepoNames.has(r.name) && r.updated !== today)
      .sort((a, b) => {
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return b.updated.localeCompare(a.updated);
      });
    const currentRepoHistoryText = currentRepoHistory.map(r =>
      `${r.name} | Tags:${r.tags.join(',')} | 璇█:${repos.find(rp => rp.name === r.name)?.language || 'N/A'} | Stars:${r.stars} | Forks:${r.forks} | Updated:${r.updated} | Desc:${r.description}`
    ).join('\n');
    const langStats = {};
    repos.forEach(r => { langStats[r.language] = (langStats[r.language] || 0) + 1; });
    const langSummary = Object.entries(langStats).sort((a, b) => b[1] - a[1]).map(([lang, count]) => `${lang}: ${count}`).join(', ');
    const currentSummaryUserContent = `浠撳簱鎬绘暟: ${validRepos.length}\n璇█鍒嗗竷: ${langSummary}\n鍚屼粨搴撳巻鍙茶褰曟暟: ${currentRepoHistory.length}\n\n璇峰湪鎬荤粨褰撳墠鐑害鐨勫悓鏃讹紝涔熺粨鍚堜笅鏂光€滃悓浠撳簱鍘嗗彶蹇収鈥濈殑淇℃伅锛屾€荤粨褰撳墠鏀堕泦鍒扮殑杩欎簺浠撳簱鐨勫巻鍙叉紨杩涘拰杩炵画鎬с€?\n\n銆愬綋鍓嶆壒娆°€慭n${currentText}\n\n銆愬悓浠撳簱鍘嗗彶蹇収銆慭n${currentRepoHistoryText || '鏃犲悓浠撳簱鍘嗗彶蹇収'}`;

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
        { role: 'system', content: buildChinesePrompt(effectiveSystemPrompt || currentSummaryPrompt) },
        { role: 'user', content: `仓库总数: ${validRepos.length}\n语言分布: ${langSummary}\n\n仓库数据:\n${currentText}` },
      ], 300000).then(result => ({ type: 'current', result }))
    );

    // Call 2: Cross-period trend summary
    const topTags = computeTopTags(validRepos, 5);
    if (topTags.length > 0) {
      const matchedHistorical = saved.repos.filter(r =>
        r.tags && r.tags.some(t => topTags.some(tt => t.toLowerCase() === tt.toLowerCase()))
      );

      if (matchedHistorical.length > 0) {
        log(`[AI] 热门标签: ${topTags.join(', ')}, 找到 ${matchedHistorical.length} 个历史匹配仓库`, 'info');

        const trendSummaryPrompt = resolvePrompt('trendSummaryPrompt',
          `你是一个GitHub趋势分析专家。以下包含两部分数据：

【当前批次】本次爬取的仓库（含标签、描述、stars、forks、更新时间）
【历史匹配】从历史数据中找到的、与当前热门标签匹配的旧仓库

热门标签：\${topTags}

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

请简洁回答，使用中文。`).replace(/\$\{topTags\}/g, topTags.join(', '));

        const trendText = `【当前批次】\n${currentText}\n\n【历史匹配仓库】\n` +
          matchedHistorical.map(r =>
            `${r.name} | Tags:${r.tags.join(',')} | Stars:${r.stars} | Forks:${r.forks} | Updated:${r.updated} | Desc:${r.description}`
          ).join('\n');

        summaryPromises.push(
          callAI([
            { role: 'system', content: buildChinesePrompt(trendSummaryPrompt) },
            { role: 'user', content: trendText },
          ], 300000).then(result => ({ type: 'trend', result }))
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

// ========== 个人推送 (Email Push) ==========

const nodemailer = require('nodemailer');
const EMAIL_PUSH_CONFIG_FILE = path.join(DATA_DIR, 'email-push-config.json');

function loadEmailPushConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(EMAIL_PUSH_CONFIG_FILE, 'utf-8'));
    let changed = false;
    // Migration: if any account still has smtpHost, extract to global smtp
    if (raw.accounts && raw.accounts.length > 0 && raw.accounts[0].smtpHost !== undefined) {
      const firstAccount = raw.accounts[0];
      raw.smtp = {
        host: firstAccount.smtpHost || '',
        port: firstAccount.smtpPort || 587,
        user: firstAccount.smtpUser || '',
        pass: firstAccount.smtpPass || '',
        useTls: firstAccount.useTls !== false,
      };
      raw.accounts = raw.accounts.map((a) => {
        const { smtpHost, smtpPort, smtpUser, smtpPass, useTls, ...rest } = a;
        return rest;
      });
      changed = true;
      log('[个人推送] 已自动迁移旧配置格式: SMTP 升级为全局统一设置', 'success');
    }
    if (!raw.smtp) {
      raw.smtp = { host: '', port: 587, user: '', pass: '', useTls: true };
      changed = true;
    }
    // Add global RSS default if not present (per-account RSS coexists independently)
    if (!raw.rss) {
      raw.rss = {
        enabled: false, repo: '', branch: 'main', filePath: 'feed.xml',
        commitMessage: 'Update RSS feed', title: '', description: '', link: '', publicUrl: '',
      };
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(EMAIL_PUSH_CONFIG_FILE, JSON.stringify(raw, null, 2));
    }
    return raw;
  } catch {
    return {
      smtp: { host: '', port: 587, user: '', pass: '', useTls: true },
      rss: { enabled: false, repo: '', branch: 'main', filePath: 'feed.xml', commitMessage: 'Update RSS feed', title: '', description: '', link: '', publicUrl: '' },
      accounts: [],
    };
  }
}

function saveEmailPushConfig(config) {
  fs.writeFileSync(EMAIL_PUSH_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function buildEmailBody(accountName, repos) {
  const cards = repos
    .map((r) => {
      const tags = (r.aiTags && r.aiTags.length > 0)
        ? r.aiTags.map((t) => `<span style="display:inline-block;background:#1c2333;color:#58a6ff;padding:1px 6px;border-radius:3px;font-size:11px;margin:1px 2px">${t}</span>`).join('')
        : '';
      const desc = r.emailIntro || r.aiDescription || r.description || '';
      const shortName = r.name || '';
      return [
        '<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px">',
        `<div style="margin-bottom:8px"><a href="${r.url}" style="color:#58a6ff;font-size:15px;font-weight:600;text-decoration:none">${shortName}</a></div>`,
        tags ? `<div style="margin-bottom:8px">${tags}</div>` : '',
        desc ? `<div style="color:#8b949e;font-size:13px;margin-bottom:10px;line-height:1.5">${desc}</div>` : '',
        '<div style="display:flex;align-items:center;gap:16px;padding-top:10px;border-top:1px solid #21262d;font-size:12px;color:#8b949e">',
        `<span><span class="material-icons" style="font-size:12px;vertical-align:text-bottom">star</span> ${r.stars || 0}</span>`,
        `<span><span class="material-icons" style="font-size:12px;vertical-align:text-bottom">call_split</span> ${r.forks || 0}</span>`,
        `<span>${r.language || 'N/A'}</span>`,
        `<span>${r.created || ''}</span>`,
        `<a href="${r.url}" style="color:#58a6ff;text-decoration:none;margin-left:auto">${shortName}</a>`,
        '</div>',
        '</div>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    '<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">',
    '</head>',
    '<body style="font-family:Arial,sans-serif;background:#0d1117;color:#e6edf3;padding:20px">',
    `<h2 style="color:#58a6ff">GitHub Scout - ${accountName} 推送</h2>`,
    `<p style="color:#8b949e">共 ${repos.length} 个仓库，${new Date().toLocaleDateString('zh-CN')} 更新</p>`,
    cards,
    '</body></html>',
  ].join('\n');
}

async function sendEmailViaSmtp(smtpConfig, account, repos) {
  log(`[个人推送] 准备发送 ${repos.length} 个仓库到 ${account.recipients.length} 个收件人`, 'info');
  log(`[个人推送] SMTP: ${smtpConfig.host}:${smtpConfig.port}, 用户: ${smtpConfig.user}`, 'info');

  let transporter;
  try {
    log(`[个人推送] 正在连接 SMTP 服务器...`, 'info');
    transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
      tls: smtpConfig.useTls !== false ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
    });
    log(`[个人推送] SMTP 连接已建立`, 'success');
  } catch (e) {
    log(`[个人推送] SMTP 连接失败: ${e.message}`, 'error');
    return account.recipients.map((r) => ({ recipient: r, ok: false, error: `连接失败: ${e.message}` }));
  }

  const subject = `GitHub Scout 仓库推送 - ${account.name} (${new Date().toLocaleDateString('zh-CN')})`;
  const html = buildEmailBody(account.name, repos);
  log(`[个人推送] 邮件正文已生成 (${Buffer.byteLength(html, 'utf8')} bytes)`, 'info');
  const results = [];

  for (let i = 0; i < account.recipients.length; i++) {
    const recipient = account.recipients[i];
    log(`[个人推送] [${i + 1}/${account.recipients.length}] 正在发送至 ${recipient}...`, 'info');
    try {
      const info = await transporter.sendMail({
        from: `"GitHub Scout" <${smtpConfig.user}>`,
        to: recipient,
        subject,
        html,
      });
      results.push({ recipient, ok: true, messageId: info.messageId });
      log(`[个人推送] [${i + 1}/${account.recipients.length}] 已发送至 ${recipient} (${info.messageId})`, 'success');
    } catch (e) {
      results.push({ recipient, ok: false, error: e.message });
      log(`[个人推送] [${i + 1}/${account.recipients.length}] 发送至 ${recipient} 失败: ${e.message}`, 'error');
      log(`[个人推送] 失败详情: code=${e.code || 'N/A'}, command=${e.command || 'N/A'}, response=${e.response || 'N/A'}`, 'error');
    }
  }
  return results;
}

async function testSmtpConnection(smtpConfig) {
  try {
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
    await transporter.verify();
    return { ok: true, message: `${smtpConfig.host}:${smtpConfig.port} 连接成功` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function handleLoadEmailPushConfig() {
  return loadEmailPushConfig();
}

function handleSaveEmailPushConfig(config) {
  try {
    saveEmailPushConfig(config);
    log('[个人推送] 配置已保存', 'success');
    return { ok: true };
  } catch (e) {
    log(`[个人推送] 配置保存失败: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

async function handleEmailPushTestSmtp(smtpConfig) {
  if (!smtpConfig || !smtpConfig.host) {
    return { ok: false, message: '请先配置 SMTP 服务器信息' };
  }
  return testSmtpConnection(smtpConfig);
}

async function handleEmailPushSend(payload) {
  log(`[个人推送] 开始发送流程...`, 'info');
  const config = loadEmailPushConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) {
    log(`[个人推送] 发送失败: 未配置全局 SMTP 设置`, 'error');
    return { ok: false, message: '请先在 SMTP 设置中配置邮件服务器' };
  }
  const account = (config.accounts || []).find((a) => a.id === payload.accountId);
  if (!account) {
    log(`[个人推送] 发送失败: 未找到指定邮箱账户 ${payload.accountId}`, 'error');
    return { ok: false, message: '未找到指定邮箱账户' };
  }
  if (!payload.repos || payload.repos.length === 0) {
    log(`[个人推送] 发送失败: 没有要发送的仓库`, 'error');
    return { ok: false, message: '没有要发送的仓库' };
  }
  if (!account.recipients || account.recipients.length === 0) {
    log(`[个人推送] 发送失败: 没有配置收件人`, 'error');
    return { ok: false, message: '没有配置收件人' };
  }

  log(`[个人推送] 发送配置: 账户=${account.name}, 仓库数=${payload.repos.length}, 收件人数=${account.recipients.length}`, 'info');

  // Generate AI intros for email (20-50 chars per repo)
  const emailIntroMap = await generateRepoIntros(payload.repos, 'emailItemIntroPrompt');
  const reposWithEmailIntros = payload.repos.map((r) => ({ ...r, emailIntro: emailIntroMap[r.name] || '' }));
  const emailIntroCount = Object.values(emailIntroMap).filter(Boolean).length;
  if (emailIntroCount > 0) {
    log(`[个人推送] AI 生成 ${emailIntroCount}/${reposWithEmailIntros.length} 条邮件介绍`, 'info');
  }

  const results = await sendEmailViaSmtp(smtp, account, reposWithEmailIntros);
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  log(`[个人推送] 发送完成: 成功 ${okCount}, 失败 ${failCount}`, okCount > 0 ? 'success' : 'error');
  const allOk = failCount === 0;
  return { ok: allOk, results };
}

async function handleEmailPushCrawl(payload, mainWindow) {
  const config = loadEmailPushConfig();
  const account = (config.accounts || []).find((a) => a.id === payload.accountId);
  if (!account) return { ok: false, message: '未找到指定邮箱账户', repos: [], total: 0 };

  // Step 1: Crawl repos
  log(`[个人推送] 开始为 ${account.name} 爬取 GitHub 仓库...`, 'info');
  const result = await handleFetchRepos({ filterConfig: account.crawlConfig });
  log(`[个人推送] ${account.name} 爬取完成，共 ${result.total} 个仓库`, 'success');

  if (!result.repos || result.repos.length === 0) {
    log(`[个人推送] ${account.name} 没有爬取到仓库，跳过 AI 分析`, 'warn');
    return { ok: true, repos: [], total: 0 };
  }

  // Step 2: Load AI config and run analysis
  const settings = loadSettings();
  const aiConfig = {
    vendor: settings.vendor || 'openai',
    vendors: settings.vendors || {},
    systemPrompt: settings.systemPrompt || '',
  };

  // Resolve the active vendor config
  let activeVendorConfig = null;
  if (aiConfig.vendors && aiConfig.vendors[aiConfig.vendor]) {
    activeVendorConfig = aiConfig.vendors[aiConfig.vendor];
  } else if (aiConfig.vendors) {
    // Fallback to first available vendor
    const firstKey = Object.keys(aiConfig.vendors)[0];
    if (firstKey) activeVendorConfig = aiConfig.vendors[firstKey];
  }

  if (!activeVendorConfig || !activeVendorConfig.baseUrl || !activeVendorConfig.apiKey) {
    log(`[个人推送] 未配置 AI，仅使用原始描述`, 'warn');
    return { ok: true, repos: result.repos, total: result.total };
  }

  log(`[个人推送] 开始 AI 分析 ${result.repos.length} 个仓库 (模型: ${activeVendorConfig.model || 'default'})...`, 'info');

  try {
    const analysisResult = await handleAnalyzeWithAI(
      {
        baseUrl: activeVendorConfig.baseUrl,
        apiKey: activeVendorConfig.apiKey,
        model: activeVendorConfig.model || '',
        systemPrompt: aiConfig.systemPrompt || '',
      },
      result.repos,
      mainWindow,
    );

    // Step 3: Merge AI tags and descriptions into repos
    const repoTags = analysisResult.repoTags || {};
    const reposWithAI = result.repos.map((repo) => {
      const aiData = repoTags[repo.name];
      return {
        ...repo,
        aiTags: aiData?.tags || [],
        aiDescription: aiData?.description || repo.description || '',
      };
    });

    const analyzedCount = Object.keys(repoTags).length;
    log(`[个人推送] AI 分析完成: ${analyzedCount}/${result.repos.length} 个仓库获得标签和描述`, 'success');
    return { ok: true, repos: reposWithAI, total: reposWithAI.length };
  } catch (e) {
    log(`[个人推送] AI 分析失败: ${e.message}，使用原始描述`, 'error');
    return { ok: true, repos: result.repos, total: result.total };
  }
}

// --- RSS Feed Generation ---

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
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`;
}

async function generateRepoIntros(repos, promptKey) {
  if (!repos || repos.length === 0) return {};
  const settings = loadSettings();
  const vendor = settings.vendor || 'openai';
  const vendors = settings.vendors || {};
  const vendorConfig = vendors[vendor] || Object.values(vendors)[0];
  if (!vendorConfig || !vendorConfig.baseUrl || !vendorConfig.apiKey) return {};

  const registry = getPromptRegistry();
  const entry = registry.find((p) => p.key === promptKey);
  const defaultPrompt = entry ? entry.defaultText : '';
  const promptText = resolvePrompt(promptKey, defaultPrompt).trim();
  if (!promptText) return {};

  const repoList = repos.map((r) => {
    const name = r.name || '';
    const lang = r.language || '?';
    const desc = (r.aiDescription || r.description || '').slice(0, 80);
    const stars = r.stars || 0;
    const tags = (r.aiTags || []).join(', ');
    return `${name} | 语言:${lang} | Stars:${stars} | 标签:${tags || '无'} | 简介:${desc}`;
  }).join('\n');

  const messages = [
    { role: 'system', content: promptText },
    { role: 'user', content: repoList },
  ];

  try {
    const result = await callAiChat(
      { baseUrl: vendorConfig.baseUrl, apiKey: vendorConfig.apiKey, model: vendorConfig.model || '' },
      messages,
      { maxTokens: 2048, temperature: 0.7 },
    );
    if (!result.ok || !result.content) return {};

    const introMap = {};
    const lines = result.content.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const intro = parts.slice(1).join('|').trim();
        if (name && intro) introMap[name] = intro;
      }
    }
    return introMap;
  } catch {
    return {};
  }
}

// --- RSS XML Builder (juya-compatible format) ---

const RSS_NS = {
  atom: 'http://www.w3.org/2005/Atom',
  content: 'http://purl.org/rss/1.0/modules/content/',
};

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

// Build RSS 2.0 channel + items (juya-compatible: CDATA on text fields, proper namespaces)
function renderRss(channelMeta, itemsXml) {
  const { title, link, description, feedUrl, buildDate, language, imageUrl } = channelMeta;
  const lang = language || 'zh-CN';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title><![CDATA[${title}]]></title>`,
    `    <link>${esc(link)}</link>`,
    `    <description><![CDATA[${description}]]></description>`,
    `    <language>${esc(lang)}</language>`,
    `    <lastBuildDate>${buildDate}</lastBuildDate>`,
    `    <docs>http://www.rssboard.org/rss-specification</docs>`,
    `    <generator>GitHub Scout</generator>`,
  ];
  if (feedUrl) {
    lines.push(`    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>`);
  }
  if (imageUrl) {
    lines.push(
      '    <image>',
      `      <url>${esc(imageUrl)}</url>`,
      `      <title><![CDATA[${title}]]></title>`,
      `      <link>${esc(link)}</link>`,
      '    </image>',
    );
  }
  lines.push(itemsXml);
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

// Build one RSS item from repo data
function renderRepoItem(repo) {
  const name = esc(cleanXml(repo.name || ''));
  const url = esc(repo.url || `https://github.com/${repo.name}`);
  const desc = repo.rssIntro || repo.aiDescription || repo.description || '';
  const lang = repo.language || 'N/A';
  return [
    '    <item>',
    `      <title>${name}</title>`,
    `      <link>${url}</link>`,
    `      <description>${esc(cleanXml(`${desc} | Stars: ${repo.stars || 0} | ${lang}`))}</description>`,
    `      <pubDate>${toRfc822Date(repo.created || repo.updated)}</pubDate>`,
    `      <guid isPermaLink="true">${url}</guid>`,
    '    </item>',
  ].join('\n');
}

// Build one RSS item per repo (juya-style: CDATA text fields, author, categories)
function renderRepoRssItem(repo) {
  const name = cleanXml(repo.name || '');
  const url = esc(repo.url || `https://github.com/${repo.name}`);
  const desc = repo.rssIntro || repo.aiDescription || repo.description || '';
  const tags = repo.aiTags || [];
  const language = repo.language || '';
  const stars = repo.stars || 0;
  const forks = repo.forks || 0;
  const dateStr = repo.created || repo.updated || '';
  const pubDate = toRfc822Date(repo.created || repo.updated);

  // Plain text summary (≤360 chars, matching juya's make_rss_summary)
  let summary = `${repo.name || ''} — ${desc}`;
  if (tags.length > 0) summary += ` | 标签: ${tags.join(', ')}`;
  summary += ` | ⭐${stars}`;
  if (language) summary += ` | ${language}`;
  if (summary.length > 360) summary = summary.slice(0, 357) + '…';
  summary = cleanXml(summary);

  // Full HTML for content:encoded (juya-style: markdown→HTML→CDATA)
  const dateDisplay = dateStr ? dateStr.slice(0, 10) : '';
  const headerLine = [`⭐ ${stars}`, forks ? `🍴 ${forks}` : '', language, dateDisplay]
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
    ...(language ? [`      <category>${esc(cleanXml(language))}</category>`] : []),
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

function parseExistingRssItems(xmlContent) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const guidRegex = /<guid[^>]*>([\s\S]*?)<\/guid>/i;
  let match;
  while ((match = itemRegex.exec(xmlContent)) !== null) {
    const itemXml = match[0];
    const guidMatch = itemXml.match(guidRegex);
    items.push({ xml: itemXml, guid: guidMatch ? guidMatch[1].trim() : '' });
  }
  return items;
}

// Per-account RSS (one item per repo)
function buildRssXml(account, repos, existingItems, maxItems) {
  const cfg = account.rssConfig || {};
  const meta = {
    title: cfg.title || `GitHub Scout - ${account.name || 'Untitled'}`,
    link: cfg.link || 'https://github.com',
    description: cfg.description || 'GitHub 仓库推送',
    feedUrl: computeRssPublicUrlFromConfig(cfg),
    buildDate: toRfc822Date(),
  };

  const newXmls = repos.map(renderRepoItem);
  const existGuids = new Set((existingItems || []).map((e) => e.guid).filter(Boolean));
  const trulyNew = newXmls.filter((_, i) => {
    const guid = repos[i].url || `https://github.com/${repos[i].name}`;
    return !existGuids.has(guid);
  });
  const all = [...trulyNew, ...(existingItems || []).map((e) => e.xml)].slice(0, maxItems || 200);
  return renderRss(meta, all.join('\n'));
}

// Global RSS (juya-style: per-repo items with CDATA, author, categories)
function buildGlobalRssXml(rssConfig, repos, existingItems, maxItems) {
  const feedUrl = computeRssPublicUrlFromConfig(rssConfig);
  const meta = {
    title: rssConfig.title || 'GitHub Scout 每日精选',
    link: rssConfig.link || 'https://github.com',
    description: rssConfig.description || 'AI 精选 GitHub 热门仓库，每日更新',
    feedUrl,
    buildDate: toRfc822Date(),
    language: 'zh-CN',
  };

  // Build per-repo items
  const newItemXmls = repos.map(renderRepoRssItem);

  // Deduplicate against existing items by guid (repo URL)
  const existGuids = new Set((existingItems || []).map((e) => e.guid).filter(Boolean));
  const trulyNew = newItemXmls.filter((_, i) => {
    const guid = repos[i].url || `https://github.com/${repos[i].name}`;
    return !existGuids.has(guid);
  });

  const all = [...trulyNew, ...(existingItems || []).map((e) => e.xml)].slice(0, maxItems || 200);
  return renderRss(meta, all.join('\n'));
}

function computeRssPublicUrl(account) {
  return computeRssPublicUrlFromConfig(account.rssConfig || {});
}

function computeRssPublicUrlFromConfig(rssConfig) {
  if (!rssConfig) return '';
  if (rssConfig.publicUrl && rssConfig.publicUrl.trim()) {
    return rssConfig.publicUrl.trim();
  }
  const repo = (rssConfig.repo || '').trim();
  const branch = (rssConfig.branch || 'main').trim();
  const filePath = (rssConfig.filePath || 'feed.xml').trim();
  if (!repo) return '';
  const parts = repo.split('/');
  if (parts.length !== 2) return '';
  const [owner, repoName] = parts;
  if (repoName.endsWith('.github.io')) {
    return `https://${repoName}/${filePath}`;
  }
  return `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${filePath}`;
}

async function handlePushRssUpload(payload) {
  const config = loadEmailPushConfig();
  const account = (config.accounts || []).find((a) => a.id === payload.accountId);
  if (!account) return { ok: false, message: '未找到指定账户' };
  if (!payload.repos || payload.repos.length === 0) {
    return { ok: false, message: '没有要上传的仓库' };
  }

  const rssConfig = account.rssConfig || {};
  const repo = (rssConfig.repo || '').trim();
  if (!repo || !repo.includes('/')) {
    return { ok: false, message: '请在 RSS 设置中填写目标仓库（格式：owner/repo）' };
  }

  // Load GitHub token
  const auth = loadAuth();
  const token = auth?.accessToken;
  if (!token) {
    return { ok: false, message: '请先在 GitHub 登录中完成认证（需要 repo 权限的 PAT）' };
  }

  const branch = (rssConfig.branch || 'main').trim();
  const filePath = (rssConfig.filePath || 'feed.xml').trim().replace(/^\//, '');
  const commitMessage = (rssConfig.commitMessage || 'Update RSS feed').trim();
  const maxItems = rssConfig.maxItems || 200;
  const [owner, repoName] = repo.split('/').map((s) => s.trim());
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(filePath)}`;

  log(`[个人推送 RSS] 开始上传到 ${repo}/${filePath}...`, 'info');

  // Step 1: Fetch existing file SHA and content (if any), merge with new repos
  let sha = null;
  let existingItems = [];
  try {
    const getRes = await httpsGet(
      `https://api.github.com${apiPath}?ref=${encodeURIComponent(branch)}`,
      buildGitHubHeaders(token),
    );
    if (getRes.statusCode === 200) {
      const parsed = parseJsonSafely(getRes.data);
      if (parsed?.sha) sha = parsed.sha;
      if (parsed?.content) {
        try {
          const oldXml = Buffer.from(parsed.content, 'base64').toString('utf-8');
          existingItems = parseExistingRssItems(oldXml);
          log(`[个人推送 RSS] 检测到已有文件 (${existingItems.length} 条)，将合并新条目 (SHA: ${sha?.slice(0, 8)}...)`, 'info');
        } catch {
          log('[个人推送 RSS] 解码旧文件失败，将覆盖原文件', 'warn');
        }
      }
    } else if (getRes.statusCode === 404) {
      log('[个人推送 RSS] 目标文件不存在，将创建新文件', 'info');
    } else {
      log(`[个人推送 RSS] 获取文件信息返回 ${getRes.statusCode}，继续尝试上传`, 'warn');
    }
  } catch (e) {
    log(`[个人推送 RSS] 获取文件信息失败: ${e.message}，继续尝试上传`, 'warn');
  }

  const introMap = await generateRepoIntros(payload.repos, 'rssItemIntroPrompt');
  const reposWithIntros = payload.repos.map((r) => ({ ...r, rssIntro: introMap[r.name] || '' }));
  const rssXml = buildRssXml(account, reposWithIntros, existingItems, maxItems);
  if (existingItems.length > 0) {
    log(`[个人推送 RSS] 合并后共 ${existingItems.length + Math.min(payload.repos.length, maxItems)} 条`, 'info');
  }

  // Step 2: Create or update file via GitHub Contents API
  const body = {
    message: commitMessage,
    content: Buffer.from(rssXml, 'utf-8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  try {
    const putRes = await httpsRequest(
      `https://api.github.com${apiPath}`,
      { headers: buildGitHubHeaders(token) },
      JSON.stringify(body),
      'PUT',
    );

    if (putRes.statusCode === 201 || putRes.statusCode === 200) {
      const publicUrl = computeRssPublicUrl(account);
      log(`[个人推送 RSS] 上传成功 (HTTP ${putRes.statusCode})`, 'success');
      log(`[个人推送 RSS] 公开地址: ${publicUrl}`, 'info');
      return {
        ok: true,
        filePath,
        repo,
        branch,
        publicUrl: publicUrl || `https://github.com/${repo}/blob/${branch}/${filePath}`,
        status: sha ? 'updated' : 'created',
      };
    }

    const parsed = parseJsonSafely(putRes.data);
    const msg = parsed?.message || `HTTP ${putRes.statusCode}`;
    log(`[个人推送 RSS] 上传失败: ${msg}`, 'error');

    // Check for common permission issues
    if (putRes.statusCode === 401 || putRes.statusCode === 403) {
      return { ok: false, message: `上传失败 (${msg})。请确认 GitHub Token 拥有 repo 权限，且你有该仓库的写入权限。` };
    }
    if (putRes.statusCode === 404) {
      return { ok: false, message: `仓库 ${repo} 不存在或分支 ${branch} 不存在` };
    }
    if (putRes.statusCode === 422) {
      return { ok: false, message: `上传失败: ${msg}` };
    }
    return { ok: false, message: `上传失败: ${msg}` };
  } catch (e) {
    log(`[个人推送 RSS] 上传异常: ${e.message}`, 'error');
    return { ok: false, message: `上传异常: ${e.message}` };
  }
}

// --- Global RSS Upload ---

async function handlePushGlobalRssUpload(payload) {
  const config = loadEmailPushConfig();
  const rssConfig = config.rss;
  if (!rssConfig || !rssConfig.enabled) {
    return { ok: false, message: '请先在 RSS 全局设置中启用并配置 RSS' };
  }
  if (!payload.repos || payload.repos.length === 0) {
    return { ok: false, message: '没有要上传的仓库' };
  }
  const repo = (rssConfig.repo || '').trim();
  if (!repo || !repo.includes('/')) {
    return { ok: false, message: '请在 RSS 设置中填写目标仓库（格式：owner/repo）' };
  }

  const auth = loadAuth();
  const token = auth?.accessToken;
  if (!token) {
    return { ok: false, message: '请先在 GitHub 登录中完成认证（需要 repo 权限的 PAT）' };
  }

  const branch = (rssConfig.branch || 'main').trim();
  const commitMessage = (rssConfig.commitMessage || 'Update RSS feed').trim();
  const fileMode = rssConfig.fileMode || 'dated';
  const [owner, repoName] = repo.split('/').map((s) => s.trim());

  // Dated mode: replace {date} with today's date
  let filePath = (rssConfig.filePath || 'feed.xml').trim().replace(/^\//, '');
  const todayStr = new Date().toISOString().slice(0, 10);
  if (fileMode === 'dated') {
    filePath = filePath.replace(/\{date\}/g, todayStr);
    if (!filePath.includes(todayStr)) {
      // Auto-insert date before .xml if no {date} placeholder
      filePath = filePath.replace(/\.xml$/, `-${todayStr}.xml`);
    }
  }
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(filePath)}`;

  log(`[全局 RSS] 模式: ${fileMode === 'dated' ? '按日期分文件' : '合并'} → ${repo}/${filePath}`, 'info');

  let sha = null;
  let existingItems = [];

  // Always check if file exists to get sha (needed for update, or error if re-publishing)
  try {
    const getRes = await httpsGet(
      `https://api.github.com${apiPath}?ref=${encodeURIComponent(branch)}`,
      buildGitHubHeaders(token),
    );
    if (getRes.statusCode === 200) {
      const parsed = parseJsonSafely(getRes.data);
      if (parsed?.sha) sha = parsed.sha;
      if (parsed?.content) {
        try {
          const oldXml = Buffer.from(parsed.content, 'base64').toString('utf-8');
          existingItems = parseExistingRssItems(oldXml);
          log(`[全局 RSS] 检测到已有文件 (${existingItems.length} 条)`, 'info');
        } catch {
          log('[全局 RSS] 解码旧文件失败，将覆盖原文件', 'warn');
        }
      }
      log(`[全局 RSS] 文件已存在，将${fileMode === 'merge' ? '合并' : '覆盖'}更新 (SHA: ${sha?.slice(0, 8)}...)`, 'info');
    } else if (getRes.statusCode === 404) {
      log(`[全局 RSS] 目标文件不存在，将创建新文件: ${filePath}`, 'info');
    }
  } catch (e) {
    log(`[全局 RSS] 获取文件信息失败: ${e.message}`, 'warn');
  }

  if (fileMode === 'merge' && existingItems.length > 0) {
    log(`[全局 RSS] 合并模式: 新 ${payload.repos.length} 条 + 已有 ${existingItems.length} 条`, 'info');
  }

  // Generate AI intros per repo
  const introMap = await generateRepoIntros(payload.repos, 'rssItemIntroPrompt');
  const reposWithIntros = payload.repos.map((r) => ({
    ...r,
    rssIntro: introMap[r.name] || '',
  }));
  const introCount = Object.values(introMap).filter(Boolean).length;
  if (introCount > 0) {
    log(`[全局 RSS] AI 生成 ${introCount}/${reposWithIntros.length} 条介绍`, 'info');
  } else {
    log('[全局 RSS] 未生成 AI 介绍（请确认 AI 配置已设置且可用）', 'warn');
  }

  // Build per-repo RSS XML (juya-style: one item per repo)
  const resolvedRssConfig = { ...rssConfig, filePath };
  const mergedExisting = fileMode === 'merge' ? existingItems : [];
  const finalXml = buildGlobalRssXml(resolvedRssConfig, reposWithIntros, mergedExisting, rssConfig.maxItems || 200);
  log(`[全局 RSS] ${reposWithIntros.length} 个仓库条目, XML ${finalXml.length} 字节`, 'info');
  log(`[全局 RSS] 前 600 字符:\n${finalXml.slice(0, 600)}`, 'info');

  // 同步到 juya 项目本地目录
  try {
    const juyaDir = 'E:/Downloads/juya-ai-daily-master';
    fs.writeFileSync(path.join(juyaDir, 'rss.xml'), finalXml, 'utf-8');

    // 每个仓库生成一个 .md 到 BACKUP/（Zola 渲染用）
    const backupDir = path.join(juyaDir, 'BACKUP');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    let mdCount = 0;
    for (const repo of reposWithIntros) {
      const name = repo.name || '';
      const url = repo.url || `https://github.com/${name}`;
      const desc = repo.rssIntro || repo.aiDescription || repo.description || '';
      const stars = repo.stars || 0;
      const forks = repo.forks || 0;
      const lang = repo.language || '';
      const tags = repo.aiTags || [];
      const dateStr = (repo.created || repo.updated || '').slice(0, 10);

      const stats = [`⭐ ${stars}`];
      if (forks) stats.push(`🍴 ${forks}`);
      if (lang && lang !== 'N/A') stats.push(lang);
      if (dateStr) stats.push(dateStr);

      const tagSpans = tags.filter(Boolean).map(t => '`' + t + '`').join(' ');

      const md = [
        `# [${name}](${url})`,
        '',
        stats.join(' | '),
        '',
        desc ? `> ${desc}` : '',
        '',
        tags.length ? '## 标签' : '',
        '',
        tagSpans || '',
        '',
        '---',
        '',
        `[查看仓库](${url})`,
        '',
      ].join('\n');

      const filename = name.replace(/[<>:"/\\\\|?*]/g, '_').replace(/\//g, '_') + '.md';
      fs.writeFileSync(path.join(backupDir, filename), md, 'utf-8');
      mdCount++;
    }
    log(`[全局 RSS] 已同步到 juya: rss.xml + ${mdCount} 个 .md -> BACKUP/`, 'success');

    // 自动 git push 触发网站构建
    exec('git add -A && git commit -m "更新仓库推荐 [GitHub Scout]" && git push', { cwd: juyaDir }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        if (msg.includes('nothing to commit')) {
          log('[全局 RSS] 内容无变化，跳过推送', 'info');
          return;
        }
        log(`[全局 RSS] git push 失败: ${msg}`, 'warn');
        return;
      }
      log('[全局 RSS] 已推送，网站即将更新: https://2538514844.github.io/juya-ai-daily/', 'success');
    });
  } catch (e) {
    log(`[全局 RSS] 同步 juya 失败: ${e.message}`, 'warn');
  }

  const body = {
    message: commitMessage,
    content: Buffer.from(finalXml, 'utf-8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  try {
    const putRes = await httpsRequest(
      `https://api.github.com${apiPath}`,
      { headers: buildGitHubHeaders(token) },
      JSON.stringify(body),
      'PUT',
    );

    if (putRes.statusCode === 201 || putRes.statusCode === 200) {
      const publicUrl = computeRssPublicUrlFromConfig({ ...rssConfig, filePath });
      log(`[全局 RSS] 上传成功 (HTTP ${putRes.statusCode})`, 'success');
      log(`[全局 RSS] 文件地址: ${publicUrl}`, 'info');

      if (fileMode === 'dated') {
        try {
          await syncRssIndexPage(token, owner, repoName, branch, rssConfig);
        } catch (e) {
          log(`[全局 RSS] 更新首页失败: ${e.message}`, 'warn');
        }
      }

      const indexUrl = computeRssIndexUrl(rssConfig, repo);
      return {
        ok: true,
        filePath,
        repo,
        branch,
        publicUrl: publicUrl || `https://github.com/${repo}/blob/${branch}/${filePath}`,
        indexUrl,
        status: sha ? 'updated' : 'created',
      };
    }

    const parsed = parseJsonSafely(putRes.data);
    const msg = parsed?.message || `HTTP ${putRes.statusCode}`;
    log(`[全局 RSS] 上传失败: ${msg}`, 'error');

    if (putRes.statusCode === 401 || putRes.statusCode === 403) {
      return { ok: false, message: `上传失败 (${msg})。请确认 GitHub Token 拥有 repo 权限，且你有该仓库的写入权限。` };
    }
    if (putRes.statusCode === 404) {
      return { ok: false, message: `仓库 ${repo} 不存在或分支 ${branch} 不存在` };
    }
    if (putRes.statusCode === 422) {
      return { ok: false, message: `上传失败: ${msg}` };
    }
    return { ok: false, message: `上传失败: ${msg}` };
  } catch (e) {
    log(`[全局 RSS] 上传异常: ${e.message}`, 'error');
    return { ok: false, message: `上传异常: ${e.message}` };
  }
}

function computeRssIndexUrl(rssConfig, repo) {
  const publicUrl = (rssConfig.publicUrl || '').trim();
  if (publicUrl) return publicUrl;
  const parts = repo.split('/');
  if (parts.length === 2 && parts[1].endsWith('.github.io')) {
    return `https://${parts[1]}/`;
  }
  return `https://github.com/${repo}`;
}

async function listRepoFeedFiles(token, owner, repoName, branch) {
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  try {
    const res = await httpsGet(treeUrl, buildGitHubHeaders(token));
    if (res.statusCode !== 200) return [];
    const data = parseJsonSafely(res.data);
    if (!data?.tree) return [];
    return data.tree
      .filter((f) => f.path && f.path.endsWith('.xml') && f.path !== 'feed.xml' && f.path !== 'index.xml')
      .map((f) => {
        const dateMatch = f.path.match(/(\d{4}-\d{2}-\d{2})/);
        return { path: f.path, date: dateMatch ? dateMatch[1] : '', size: f.size || 0 };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function buildRssIndexHtml(rssConfig, feedFiles) {
  const title = escapeXml(rssConfig.title || 'GitHub Scout RSS');
  const desc = escapeXml(rssConfig.description || '');

  const fileRows = feedFiles.map((f) => {
    const displayDate = f.date || f.path.replace(/\.xml$/, '').split('-').slice(-3).join('-');
    const sizeKb = (f.size / 1024).toFixed(1);
    return [
      '      <tr>',
      `        <td style="padding:8px 12px;border-bottom:1px solid #30363d;">${escapeXml(displayDate)}</td>`,
      `        <td style="padding:8px 12px;border-bottom:1px solid #30363d;"><a href="${escapeXml(f.path)}" style="color:#58a6ff;text-decoration:none;">${escapeXml(f.path)}</a></td>`,
      `        <td style="padding:8px 12px;border-bottom:1px solid #30363d;text-align:right;">${sizeKb} KB</td>`,
      '      </tr>',
    ].join('\n');
  }).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${title}</title>`,
    '  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">',
    '  <style>',
    '    body { font-family: "Google Sans", "Noto Sans SC", sans-serif; background: #0d1117; color: #c9d1d9; max-width: 800px; margin: 0 auto; padding: 40px 20px; }',
    '    h1 { color: #f0f6fc; font-size: 24px; margin-bottom: 4px; }',
    '    .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }',
    '    table { width: 100%; border-collapse: collapse; }',
    '    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; color: #8b949e; font-size: 12px; font-weight: 600; }',
    '    tr:hover td { background: #161b22; }',
    '    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #21262d; font-size: 12px; color: #484f58; }',
    '  </style>',
    '</head>',
    '<body>',
    `  <h1>${title}</h1>`,
    desc ? `  <p class="subtitle">${escapeXml(desc)}</p>` : '',
    '  <table>',
    '    <thead><tr><th>日期</th><th>文件</th><th style="text-align:right;">大小</th></tr></thead>',
    '    <tbody>',
    fileRows || '      <tr><td colspan="3" style="padding:16px;color:#484f58;text-align:center;">暂无 RSS 文件</td></tr>',
    '    </tbody>',
    '  </table>',
    '  <div class="footer">GitHub Scout RSS &middot; 点击文件链接即可在 RSS 阅读器中订阅</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

async function syncRssIndexPage(token, owner, repoName, branch, rssConfig) {
  const feedFiles = await listRepoFeedFiles(token, owner, repoName, branch);
  log(`[全局 RSS] 发现 ${feedFiles.length} 个 RSS 文件`, 'info');
  const html = buildRssIndexHtml(rssConfig, feedFiles);
  const indexPath = 'index.html';
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodeURIComponent(indexPath)}`;

  let sha = null;
  try {
    const getRes = await httpsGet(
      `https://api.github.com${apiPath}?ref=${encodeURIComponent(branch)}`,
      buildGitHubHeaders(token),
    );
    if (getRes.statusCode === 200) {
      const parsed = parseJsonSafely(getRes.data);
      if (parsed?.sha) sha = parsed.sha;
    }
  } catch { /* file doesn't exist yet */ }

  const body = {
    message: 'Update RSS index',
    content: Buffer.from(html, 'utf-8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  await httpsRequest(
    `https://api.github.com${apiPath}`,
    { headers: buildGitHubHeaders(token) },
    JSON.stringify(body),
    'PUT',
  );
  log('[全局 RSS] 首页目录已更新', 'success');
}

function handleLoadGlobalRss() {
  const config = loadEmailPushConfig();
  return { ok: true, rss: config.rss || { enabled: false, repo: '', branch: 'main', filePath: 'feed.xml', fileMode: 'dated', commitMessage: 'Update RSS feed', title: '', description: '', link: '', publicUrl: '', maxItems: 200 } };
}

function handleSaveGlobalRss(rssConfig) {
  try {
    const config = loadEmailPushConfig();
    config.rss = {
      enabled: rssConfig.enabled !== false,
      repo: rssConfig.repo || '',
      branch: rssConfig.branch || 'main',
      filePath: rssConfig.filePath || 'feed.xml',
      commitMessage: rssConfig.commitMessage || 'Update RSS feed',
      title: rssConfig.title || '',
      description: rssConfig.description || '',
      link: rssConfig.link || '',
      publicUrl: rssConfig.publicUrl || '',
      fileMode: rssConfig.fileMode || 'dated',
      maxItems: rssConfig.maxItems || 200,
    };
    saveEmailPushConfig(config);
    log('[全局 RSS] 设置已保存', 'success');
    return { ok: true };
  } catch (e) {
    log(`[全局 RSS] 保存失败: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

function handleLoadGlobalSmtp() {
  const config = loadEmailPushConfig();
  return { ok: true, smtp: config.smtp || { host: '', port: 587, user: '', pass: '', useTls: true } };
}

function handleSaveGlobalSmtp(smtpConfig) {
  try {
    const config = loadEmailPushConfig();
    config.smtp = {
      host: smtpConfig.host || '',
      port: smtpConfig.port || 587,
      user: smtpConfig.user || '',
      pass: smtpConfig.pass || '',
      useTls: smtpConfig.useTls !== false,
    };
    saveEmailPushConfig(config);
    log('[个人推送] 全局SMTP设置已保存', 'success');
    return { ok: true };
  } catch (e) {
    log(`[个人推送] 全局SMTP保存失败: ${e.message}`, 'error');
    return { ok: false, message: e.message };
  }
}

function handleTestGlobalSmtp(smtpConfig) {
  return testSmtpConnection(smtpConfig);
}

function handleLoadAllPrompts() {
  const registry = getPromptRegistry();
  const values = {};
  for (const entry of registry) {
    let defaultText = entry.defaultText;
    if (entry.filePath) {
      const filePath = path.join(__dirname, '..', entry.filePath);
      if (fs.existsSync(filePath)) {
        defaultText = fs.readFileSync(filePath, 'utf8').trim();
      }
    }
    const currentText = resolvePrompt(entry.key, defaultText);
    values[entry.key] = {
      defaultText,
      currentText,
      isCustomized: Boolean(promptOverrides[entry.key] && String(promptOverrides[entry.key]).trim()),
      isTemplate: entry.isTemplate,
      templateVars: entry.templateVars || [],
    };
  }

  const promptsMeta = registry.map(e => ({
    key: e.key,
    name: e.name,
    category: e.category,
    isTemplate: e.isTemplate,
    templateVars: e.templateVars || [],
  }));

  return { prompts: promptsMeta, values };
}

function handleSavePrompt(key, text) {
  const registry = getPromptRegistry();
  const entry = registry.find(e => e.key === key);
  if (!entry) {
    return { ok: false, message: `Unknown prompt key: ${key}` };
  }
  const trimmed = String(text || '').trim();

  // Record previous version to history before overwriting
  if (promptOverrides[key] && String(promptOverrides[key]).trim()) {
    if (!promptHistory[key]) promptHistory[key] = [];
    const prevText = String(promptOverrides[key]).trim();
    // Don't record if identical to the last history entry
    const lastEntry = promptHistory[key].length > 0 ? promptHistory[key][promptHistory[key].length - 1] : null;
    if (!lastEntry || lastEntry.text !== prevText) {
      promptHistory[key].push({
        text: prevText,
        timestamp: new Date().toISOString(),
        version: promptHistory[key].length + 1,
      });
      // Keep last 30 versions per prompt
      if (promptHistory[key].length > 30) {
        promptHistory[key] = promptHistory[key].slice(-30);
      }
    }
  }

  if (trimmed) {
    promptOverrides[key] = trimmed;
  } else {
    delete promptOverrides[key];
  }
  savePromptOverrides();
  savePromptHistory();
  log(`[配置] 提示词 "${entry.name}" 已保存`, 'success');
  return { ok: true };
}

function handleResetPrompt(key) {
  delete promptOverrides[key];
  savePromptOverrides();
  log(`[配置] 提示词 "${key}" 已重置为默认`, 'success');
  return { ok: true };
}

function handleGetPromptHistory(key) {
  const entries = promptHistory[key] || [];
  return {
    ok: true,
    key,
    history: entries.map((e, i) => ({
      version: e.version,
      timestamp: e.timestamp,
      text: e.text,
      index: i,
    })),
  };
}

function handleRollbackPrompt(key, versionIndex) {
  const history = promptHistory[key] || [];
  if (versionIndex < 0 || versionIndex >= history.length) {
    return { ok: false, message: `Invalid version index: ${versionIndex}` };
  }
  const target = history[versionIndex];
  if (!target) {
    return { ok: false, message: 'Version not found' };
  }

  // Save current version to history before rolling back
  if (promptOverrides[key] && String(promptOverrides[key]).trim()) {
    const lastEntry = history.length > 0 ? history[history.length - 1] : null;
    if (!lastEntry || lastEntry.text !== String(promptOverrides[key]).trim()) {
      history.push({
        text: String(promptOverrides[key]).trim(),
        timestamp: new Date().toISOString(),
        version: history.length + 1,
      });
    }
  }

  promptOverrides[key] = target.text;
  savePromptOverrides();
  savePromptHistory();
  log(`[配置] 提示词 "${key}" 已回退到版本 ${target.version}`, 'success');
  return { ok: true, text: target.text, version: target.version };
}

function patchLatestCarouselFooterFontSize(fontSize) {
  const dir = README_CAROUSEL_RUNS_DIR;
  if (!fs.existsSync(dir)) return { ok: false, message: '没有找到车播输出目录。' };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const runDir of dirs) {
    const manifestPath = path.join(runDir.path, 'manifest.json');
    const indexHtmlPath = path.join(runDir.path, 'index.html');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(indexHtmlPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const items = (manifest.items || []).map((item) => ({
        title: item.title,
        repoName: item.repoName,
        repoUrl: item.repoUrl,
        htmlEntryPath: item.htmlEntryPath || item.htmlFileName,
        audioEntryPath: item.audioEntryPath || item.audioFileName,
        audioDurationMs: item.audioDurationMs || null,
      }));
      const soundPath = path.join(runDir.path, 'page-turn-sound.mp3');
      const pageTurnSoundEntryPath = fs.existsSync(soundPath) ? soundPath : '';
      fs.writeFileSync(indexHtmlPath, buildCarouselIndexHtml(items, pageTurnSoundEntryPath, fontSize), 'utf8');
      log(`[README] 已更新车播底部字号: ${fontSize}px → ${indexHtmlPath}`, 'success');
      return { ok: true, path: indexHtmlPath, fontSize };
    } catch (e) {
      log(`[README] 车播字号补丁失败: ${runDir.path} - ${e.message}`, 'warn');
      continue;
    }
  }
  log('[README] 没有找到可修补的车播输出。', 'warn');
  return { ok: false, message: '没有找到可修补的车播输出。' };
}

function handleLoadRepoHistory(page = 1, pageSize = 200) {
  const analysis = loadRepoAnalysis();
  const repos = analysis.repos || [];

  // 扫描所有车播 manifest，找出已生成过 HTML 的仓库
  const carouselRepos = new Set();
  if (fs.existsSync(README_CAROUSEL_RUNS_DIR)) {
    const entries = fs.readdirSync(README_CAROUSEL_RUNS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(README_CAROUSEL_RUNS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        for (const item of (manifest.items || [])) {
          if (item.repoName) carouselRepos.add(item.repoName);
        }
      } catch (e) {
        // 跳过损坏的 manifest
      }
    }
  }

  const enriched = repos.map((repo) => ({
    ...repo,
    hasCarousel: carouselRepos.has(repo.name),
  }));

  const start = (page - 1) * pageSize;
  const pageItems = enriched.slice(start, start + pageSize);

  return {
    ok: true,
    repos: pageItems,
    total: enriched.length,
    page,
    pageSize,
    hasMore: start + pageSize < enriched.length,
    carouselCount: carouselRepos.size,
  };
}

module.exports = {
  handleFetchRepos, handleAnalyzeWithAI, handleFetchSelectedReadmes, handleTestConnection,
  patchLatestCarouselFooterFontSize, handleLoadRepoHistory,
  loadSettings, saveSettings,
  handleStartGitHubLogin, handlePollGitHubToken, handleLoginWithPat, handleGetAuthStatus, handleLogout,
  handleSaveAiConfig, handleLoadAiConfig,
  handleLoadEmailPushConfig, handleSaveEmailPushConfig,
  handleEmailPushTestSmtp, handleEmailPushSend, handleEmailPushCrawl,
  handlePushRssUpload, computeRssPublicUrl,
  handleLoadGlobalSmtp, handleSaveGlobalSmtp, handleTestGlobalSmtp,
  handlePushGlobalRssUpload, handleLoadGlobalRss, handleSaveGlobalRss,
  handleLoadAllPrompts, handleSavePrompt, handleResetPrompt,
  handleGetPromptHistory, handleRollbackPrompt,
  logEmitter, log,
};
