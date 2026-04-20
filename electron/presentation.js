const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRESENTATION_SETTINGS_FILE = path.join(DATA_DIR, 'presentation-settings.json');
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');

const DEFAULT_PRESENTATION_CONFIG = {
  tts: {
    apiUrl: 'https://api.minimaxi.com/v1/t2a_v2',
    apiKey: '',
    model: 'speech-2.8-hd',
    voiceId: 'male-qn-qingse',
    speed: 1,
    volume: 1,
    pitch: 0,
    emotion: '',
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  },
  player: {
    pageReadyDelayMs: 600,
    holdAfterAudioMs: 300,
    pageLoadTimeoutMs: 8000,
  },
  playlistText: '',
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(DATA_DIR);
ensureDir(TTS_CACHE_DIR);

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeTtsConfig(rawConfig = {}) {
  const merged = {
    ...DEFAULT_PRESENTATION_CONFIG.tts,
    ...(rawConfig || {}),
  };

  return {
    apiUrl: String(merged.apiUrl || DEFAULT_PRESENTATION_CONFIG.tts.apiUrl).trim(),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || DEFAULT_PRESENTATION_CONFIG.tts.model).trim(),
    voiceId: String(merged.voiceId || DEFAULT_PRESENTATION_CONFIG.tts.voiceId).trim(),
    speed: clampNumber(merged.speed, 0.5, 2, DEFAULT_PRESENTATION_CONFIG.tts.speed),
    volume: clampNumber(merged.volume, 0, 10, DEFAULT_PRESENTATION_CONFIG.tts.volume),
    pitch: clampNumber(merged.pitch, -12, 12, DEFAULT_PRESENTATION_CONFIG.tts.pitch),
    emotion: String(merged.emotion || '').trim(),
    sampleRate: clampNumber(merged.sampleRate, 8000, 48000, DEFAULT_PRESENTATION_CONFIG.tts.sampleRate),
    bitrate: clampNumber(merged.bitrate, 32000, 320000, DEFAULT_PRESENTATION_CONFIG.tts.bitrate),
    format: String(merged.format || DEFAULT_PRESENTATION_CONFIG.tts.format).trim() || 'mp3',
    channel: clampNumber(merged.channel, 1, 2, DEFAULT_PRESENTATION_CONFIG.tts.channel),
  };
}

function normalizePlayerConfig(rawConfig = {}) {
  const merged = {
    ...DEFAULT_PRESENTATION_CONFIG.player,
    ...(rawConfig || {}),
  };

  return {
    pageReadyDelayMs: clampNumber(
      merged.pageReadyDelayMs,
      0,
      10000,
      DEFAULT_PRESENTATION_CONFIG.player.pageReadyDelayMs,
    ),
    holdAfterAudioMs: clampNumber(
      merged.holdAfterAudioMs,
      0,
      10000,
      DEFAULT_PRESENTATION_CONFIG.player.holdAfterAudioMs,
    ),
    pageLoadTimeoutMs: clampNumber(
      merged.pageLoadTimeoutMs,
      1000,
      30000,
      DEFAULT_PRESENTATION_CONFIG.player.pageLoadTimeoutMs,
    ),
  };
}

function loadPresentationConfig() {
  const saved = readJsonFile(PRESENTATION_SETTINGS_FILE, {});

  return {
    tts: normalizeTtsConfig(saved.tts),
    player: normalizePlayerConfig(saved.player),
    playlistText: typeof saved.playlistText === 'string' ? saved.playlistText : '',
  };
}

function savePresentationConfig(config = {}) {
  const next = {
    tts: normalizeTtsConfig(config.tts),
    player: normalizePlayerConfig(config.player),
    playlistText: typeof config.playlistText === 'string' ? config.playlistText : '',
  };

  writeJsonFile(PRESENTATION_SETTINGS_FILE, next);
  return next;
}

function parsePresentationPlaylist(rawPlaylist) {
  if (!rawPlaylist) {
    throw new Error('播放清单为空，请先提供至少一个网页条目。');
  }

  let playlist = rawPlaylist;
  if (typeof rawPlaylist === 'string') {
    try {
      playlist = JSON.parse(rawPlaylist);
    } catch {
      throw new Error('播放清单不是合法 JSON。');
    }
  }

  const items = Array.isArray(playlist)
    ? playlist
    : Array.isArray(playlist.items)
      ? playlist.items
      : [];

  if (items.length === 0) {
    throw new Error('播放清单里没有可用的网页条目。');
  }

  return items;
}

function buildLocalHtmlDocument(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  if (!resolvedPath) {
    throw new Error('本地 HTML 路径不能为空。');
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`找不到本地 HTML：${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`不是有效文件：${resolvedPath}`);
  }

  const fileText = fs.readFileSync(resolvedPath, 'utf8');
  const baseHref = pathToFileURL(path.dirname(resolvedPath) + path.sep).href;
  const baseTag = `<base href="${baseHref}">`;

  let html = fileText;
  if (/<base\s/i.test(html)) {
    return {
      kind: 'srcDoc',
      srcDoc: html,
      sourcePath: resolvedPath,
    };
  }

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  } else {
    html = `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
  }

  return {
    kind: 'srcDoc',
    srcDoc: html,
    sourcePath: resolvedPath,
  };
}

function buildPageSource(item) {
  const htmlPath = typeof item.htmlPath === 'string' ? item.htmlPath.trim() : '';
  const url = typeof item.url === 'string' ? item.url.trim() : '';

  if (htmlPath) {
    return buildLocalHtmlDocument(htmlPath);
  }

  if (!url) {
    throw new Error('每个条目都必须提供 url 或 htmlPath。');
  }

  const parsed = new URL(url);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`仅支持 http/https 远程网页：${url}`);
  }

  return {
    kind: 'url',
    url: parsed.toString(),
  };
}

function normalizePresentationItems(rawItems, playerConfig) {
  return rawItems.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个网页条目不是对象。`);
    }

    const title = String(item.title || item.label || `网页 ${index + 1}`).trim();
    const narration = String(item.ttsText || item.narration || '').trim();
    if (!narration) {
      throw new Error(`第 ${index + 1} 个网页缺少 ttsText。`);
    }
    if (narration.length > 10000) {
      throw new Error(`第 ${index + 1} 个网页的 ttsText 超过 MiniMax 同步 TTS 的 10000 字限制。`);
    }

    return {
      id: `presentation-item-${index + 1}`,
      title,
      ttsText: narration,
      pageReadyDelayMs: clampNumber(
        item.pageReadyDelayMs,
        0,
        10000,
        playerConfig.pageReadyDelayMs,
      ),
      holdAfterAudioMs: clampNumber(
        item.holdAfterAudioMs,
        0,
        10000,
        playerConfig.holdAfterAudioMs,
      ),
      pageLoadTimeoutMs: clampNumber(
        item.pageLoadTimeoutMs,
        1000,
        30000,
        playerConfig.pageLoadTimeoutMs,
      ),
      page: buildPageSource(item),
    };
  });
}

function httpsPostJson(url, token, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);

    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          reject(new Error(`MiniMax 返回了无法解析的响应（HTTP ${response.statusCode}）。`));
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = json?.base_resp?.status_msg || json?.message || `HTTP ${response.statusCode}`;
          reject(new Error(`MiniMax TTS 请求失败：${message}`));
          return;
        }

        resolve(json);
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('MiniMax TTS 请求超时。'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function normalizeDurationMs(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  return Math.round(duration);
}

function getTtsCacheMetaPath(cachePath) {
  return `${cachePath}.json`;
}

function readTtsCacheMeta(cachePath) {
  const metaPath = getTtsCacheMetaPath(cachePath);
  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const durationMs = normalizeDurationMs(parsed?.durationMs);
    if (!durationMs) {
      return null;
    }

    return {
      durationMs,
    };
  } catch {
    return null;
  }
}

function writeTtsCacheMeta(cachePath, durationMs) {
  const normalizedDurationMs = normalizeDurationMs(durationMs);
  if (!normalizedDurationMs) {
    return null;
  }

  const metaPath = getTtsCacheMetaPath(cachePath);
  fs.writeFileSync(metaPath, JSON.stringify({
    durationMs: normalizedDurationMs,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  return {
    durationMs: normalizedDurationMs,
    metaPath,
  };
}

function estimateWavDurationMs(audioPath) {
  try {
    const buffer = fs.readFileSync(audioPath);
    if (buffer.length < 12) {
      return null;
    }

    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let byteRate = null;
    let dataSize = null;
    let offset = 12;

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkDataStart = offset + 8;

      if (chunkId === 'fmt ' && chunkSize >= 12 && chunkDataStart + 12 <= buffer.length) {
        byteRate = buffer.readUInt32LE(chunkDataStart + 8);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }

      if (byteRate && dataSize) {
        break;
      }

      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (!byteRate || !dataSize) {
      return null;
    }

    return normalizeDurationMs((dataSize / byteRate) * 1000);
  } catch {
    return null;
  }
}

function estimateMp3DurationMs(audioPath, ttsConfig) {
  try {
    const stats = fs.statSync(audioPath);
    const bitrate = Number(ttsConfig?.bitrate);
    if (!stats.isFile() || stats.size <= 0 || !Number.isFinite(bitrate) || bitrate <= 0) {
      return null;
    }

    return normalizeDurationMs((stats.size * 8 * 1000) / bitrate);
  } catch {
    return null;
  }
}

function estimateAudioDurationMs(audioPath, ttsConfig) {
  const extension = path.extname(audioPath).toLowerCase();
  if (extension === '.wav') {
    return estimateWavDurationMs(audioPath);
  }

  if (extension === '.mp3') {
    return estimateMp3DurationMs(audioPath, ttsConfig);
  }

  return null;
}

function resolveCachedAudioDurationMs(cachePath, ttsConfig) {
  const cachedMeta = readTtsCacheMeta(cachePath);
  if (cachedMeta?.durationMs) {
    return cachedMeta.durationMs;
  }

  const estimatedDurationMs = estimateAudioDurationMs(cachePath, ttsConfig);
  if (estimatedDurationMs) {
    writeTtsCacheMeta(cachePath, estimatedDurationMs);
  }

  return estimatedDurationMs;
}

async function synthesizeTtsToCache(text, ttsConfig) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    text,
    model: ttsConfig.model,
    voiceId: ttsConfig.voiceId,
    speed: ttsConfig.speed,
    volume: ttsConfig.volume,
    pitch: ttsConfig.pitch,
    emotion: ttsConfig.emotion,
    sampleRate: ttsConfig.sampleRate,
    bitrate: ttsConfig.bitrate,
    format: ttsConfig.format,
    channel: ttsConfig.channel,
  })).digest('hex');

  const extension = ttsConfig.format === 'wav' ? 'wav' : ttsConfig.format || 'mp3';
  const cachePath = path.join(TTS_CACHE_DIR, `${hash}.${extension}`);

  if (fs.existsSync(cachePath)) {
    const durationMs = resolveCachedAudioDurationMs(cachePath, ttsConfig);
    return {
      audioPath: cachePath,
      audioUrl: pathToFileURL(cachePath).href,
      durationMs,
      cached: true,
    };
  }

  const payload = {
    model: ttsConfig.model,
    text,
    stream: false,
    voice_setting: {
      voice_id: ttsConfig.voiceId,
      speed: ttsConfig.speed,
      vol: ttsConfig.volume,
      pitch: ttsConfig.pitch,
      ...(ttsConfig.emotion ? { emotion: ttsConfig.emotion } : {}),
    },
    audio_setting: {
      sample_rate: ttsConfig.sampleRate,
      bitrate: ttsConfig.bitrate,
      format: ttsConfig.format,
      channel: ttsConfig.channel,
    },
    subtitle_enable: false,
    output_format: 'hex',
  };

  const response = await httpsPostJson(ttsConfig.apiUrl, ttsConfig.apiKey, payload);
  const statusCode = response?.base_resp?.status_code;
  if (statusCode !== 0) {
    throw new Error(`MiniMax TTS 返回错误：${response?.base_resp?.status_msg || '未知错误'}`);
  }

  const hexAudio = response?.data?.audio;
  if (!hexAudio) {
    throw new Error('MiniMax TTS 没有返回音频数据。');
  }

  const audioBuffer = Buffer.from(hexAudio, 'hex');
  fs.writeFileSync(cachePath, audioBuffer);
  const durationMs =
    normalizeDurationMs(response?.extra_info?.audio_length)
    || estimateAudioDurationMs(cachePath, ttsConfig);

  if (durationMs) {
    writeTtsCacheMeta(cachePath, durationMs);
  }

  return {
    audioPath: cachePath,
    audioUrl: pathToFileURL(cachePath).href,
    durationMs,
    cached: false,
  };
}

async function testPresentationTts(rawConfig = {}) {
  const ttsConfig = normalizeTtsConfig(rawConfig);

  if (!ttsConfig.apiUrl) {
    return {
      ok: false,
      message: '请先填写 MiniMax API URL。',
    };
  }

  if (!ttsConfig.apiKey) {
    return {
      ok: false,
      message: '请先填写 MiniMax API Key。',
    };
  }

  try {
    const result = await synthesizeTtsToCache('你好，这是一条 MiniMax TTS 测试语音。', ttsConfig);
    return {
      ok: true,
      message: 'MiniMax TTS 测试成功。',
      model: ttsConfig.model,
      voiceId: ttsConfig.voiceId,
      cached: result.cached,
      audioPath: result.audioPath,
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message || 'MiniMax TTS 测试失败。',
    };
  }
}

async function preparePresentationSession(payload = {}, onProgress = () => {}) {
  const ttsConfig = normalizeTtsConfig(payload.ttsConfig);
  const playerConfig = normalizePlayerConfig(payload.playerConfig);
  const rawItems = parsePresentationPlaylist(payload.playlist);

  if (!ttsConfig.apiKey) {
    throw new Error('请先填写 MiniMax API Key。');
  }

  const items = normalizePresentationItems(rawItems, playerConfig);
  const preparedItems = [];

  onProgress({
    stage: 'start',
    total: items.length,
    completed: 0,
  });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    onProgress({
      stage: 'tts',
      total: items.length,
      completed: index,
      current: index + 1,
      title: item.title,
    });

    const audio = await synthesizeTtsToCache(item.ttsText, ttsConfig);
    preparedItems.push({
      ...item,
      audioUrl: audio.audioUrl,
      audioPath: audio.audioPath,
      audioDurationMs: audio.durationMs,
      audioCached: audio.cached,
    });

    onProgress({
      stage: 'prepared-item',
      total: items.length,
      completed: index + 1,
      current: index + 1,
      title: item.title,
      cached: audio.cached,
    });
  }

  onProgress({
    stage: 'done',
    total: items.length,
    completed: items.length,
  });

  return {
    ok: true,
    totalItems: preparedItems.length,
    preparedAt: new Date().toISOString(),
    items: preparedItems,
    playerConfig,
    ttsConfig: {
      model: ttsConfig.model,
      voiceId: ttsConfig.voiceId,
      speed: ttsConfig.speed,
      volume: ttsConfig.volume,
      pitch: ttsConfig.pitch,
      emotion: ttsConfig.emotion,
      format: ttsConfig.format,
    },
  };
}

function loadPresentationManifest(manifestPath) {
  const resolved = path.resolve(String(manifestPath || ''));
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error('找不到播放清单文件。');
  }

  return {
    path: resolved,
    content: fs.readFileSync(resolved, 'utf8'),
  };
}

module.exports = {
  DEFAULT_PRESENTATION_CONFIG,
  loadPresentationConfig,
  savePresentationConfig,
  preparePresentationSession,
  loadPresentationManifest,
  synthesizeTtsToCache,
  testPresentationTts,
};
