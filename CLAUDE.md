# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start Vite dev server only (for frontend work)
npm run dev

# Start full Electron + Vite dev environment
npm run electron:dev

# Build frontend
npm run build

# Build Windows Electron portable executable
npm run electron:build

# Batch dev startup (Windows)
启动.bat
```

- The Vite dev server runs on port 5290 (strict). `electron:dev` auto-finds an available port via `scripts/electron-dev.js`, which starts Vite first, waits for it with `wait-on`, then spawns Electron — both share `VITE_DEV_SERVER_URL`.
- No test runner or linter is configured. If adding tests, use a lightweight setup consistent with React 19 + Vite.

## Project Architecture

### Stack
- **Electron** — main process, IPC handlers, native dialogs, window management
- **React 19** — renderer in `src/`
- **Vite 6** — bundler via `@vitejs/plugin-react`
- **antd** — listed as devDependency but not currently imported (UI is custom CSS)

### Three-Layer Structure

**1. Electron main process** (`electron/main.js`)
- Creates frameless main window (1400x900, min 1000x700) and optional recorder window (fullscreen for README carousel video capture)
- Registers all IPC handlers — each handler delegates to a function in `electron/ipc.js`
- Log distribution: `logEmitter` (EventEmitter) sends log entries to renderer via `webContents.send('log-entry', ...)`

**2. Backend service layer** (`electron/ipc.js`, ~4050 lines)
All backend logic lives here. Key modules when read top-to-bottom:
- **Utility layer**: HTTP helpers (`httpsRequest`, `httpsGet`), JSON parsing, GitHub header builder
- **AI parsing**: Structured output extraction from AI responses (`extractOpenAiCompatibleMessage`, `parseStructuredRepoTagMap`, `parseStructuredRepoTagMapFromJson`) with retry logic and model fallback (e.g. DeepSeek reasoner → chat for structured output)
- **GitHub API**: Repo search (`fetchGitHub`, `handleFetchRepos`), README fetching (`fetchRepoReadme`, `handleFetchSelectedReadmes`), auth (device flow + PAT login)
- **README carousel**: Full HTML slideshow generation pipeline. The AI system prompt template lives in `prompts/final_prompt.txt` (~900 lines). Pipeline: AI narration → TTS audio via MiniMax API → local image injection → carousel index building → video recording with screen capture (WebM) → ffmpeg transcode to MP4 (4K, x264 CRF 18, AAC 320k)
- **AI analysis**: Multi-provider support (OpenAI-compatible as default, plus Anthropic route). Connection testing, repo batch analysis with progress reporting, structured tag/description output, history-aware analysis (reuses tags from similar past repos)
- **Email & RSS push**: Crawl repos via GitHub Search, auto-analyze with AI, then output via two channels from the same account config — (1) bulk-send curated repo lists as HTML email via SMTP (`nodemailer`), (2) auto-upload RSS 2.0 XML to a GitHub repo via the Contents API for RSS reader subscription. Supports per-account SMTP config, recipient management, RSS repo/branch/path config, crawl settings, and inline repo data editing before send/upload.
- **Prompt overrides**: `resolvePrompt(key, default)` checks `data/prompts.json` for user overrides before falling back to hardcoded defaults. All 16 prompt registry entries use this. Template prompts store literal `${var}` placeholders substituted via `.replace()` at runtime. Each save creates a version history entry in `data/prompts-history.json`, supporting per-prompt rollback.
- **Data persistence**: JSON files in `data/` — `settings.json` (AI config), `auth.json` (GitHub token), `repo_analysis.json` (analysis history), `email-push-config.json` (SMTP accounts, recipients, crawl settings), `prompts.json` (AI prompt overrides), `prompts-history.json` (version history per prompt key), `presentation-settings.json` (TTS config + playlist), `tts-cache/` (cached TTS audio), `readme-carousel-runs/` (generated carousel HTML sessions)
- **Video transcode**: `main.js` includes a WebM→MP4 ffmpeg pipeline using `ffmpeg-static`. `electron-builder.json` has `asarUnpack` for `node_modules/ffmpeg-static/**/*` — ffmpeg can't run from within an asar archive

**`electron/presentation.js`** (~650 lines) — Standalone TTS and slideshow manager:
- MiniMax TTS API integration with local audio caching (`data/tts-cache/`)
- WAV/MP3 duration estimation for audio synchronization
- Playlist parsing and carousel HTML generation
- Manifest loading for stored presentation sessions

**`electron/local-image-runtime.js`** — Small utility injecting CSS for local image modals in README HTML

**`electron/recorder-preload.cjs`** — Screen recording preload script injected into the recorder window. Uses `MediaRecorder` API with auto-format detection, overlay UI for record/stop/save controls.

**3. React renderer** (`src/`)

| Component | Purpose |
|---|---|
| `App.jsx` | Main orchestrator — state for repos, analysis, AI config, auth, logs. Contains filter config, reasoning model detection logic, auto-pick model fallback. |
| `ConfigPanel.jsx` | AI provider configuration (base URL, API key, model) with presets for OpenAI, Claude, SiliconFlow, DeepSeek, Zhipu, Ollama, Custom. Includes connection test button. |
| `RepoTable.jsx` | Displays fetched repos in a table with selection, CSV export |
| `RepoImagePanel.jsx` | Local image picker/manager per repo |
| `AnalysisView.jsx` | Renders AI analysis output as styled HTML (markdown-like → DOM with clickable repo/external links) |
| `Auth.jsx` | GitHub login (PAT) and logout UI |
| `LogPanel.jsx` | Tabbed log viewer (fetch, analyze, auth, config logs) |
| `PresentationStudio.jsx` | Presentation/TTS configuration and playlist editing UI |
| `PresentationPlayerOverlay.jsx` | In-app player overlay for carousel preview |
| `EmailPushPanel.jsx` | SMTP account + RSS feed management per account — SMTP settings, recipient list, RSS repo/branch/path config, crawl settings (keywords, date range, stars, pages) |
| `EmailPushEditor.jsx` | Full-screen overlay for reviewing/editing crawled repos before output — checkbox selection, inline editing, "发送邮件" to SMTP recipients and "上传 RSS" to push to configured GitHub repo |
| `PromptEditorPanel.jsx` | Visual editor for all AI prompt templates — browse by category, search, edit with monospace textarea, save/reset per prompt |
| `hooks/useUiSwitchSound.js` | Custom hook managing an Audio element pool for UI switch sounds |

### IPC Bridge
`electron/preload.cjs` exposes `window.electronAPI` via `contextBridge` — the only way the renderer communicates with the backend. No direct Node.js access from renderer code.

### Key IPC Channels

**Core workflow**
| Channel | Direction | Purpose |
|---|---|---|
| `fetch-repos` | renderer → main | GitHub repo search |
| `fetch-selected-readmes` | renderer → main | Fetch READMEs for selected repos |
| `analyze-repos` | renderer → main | AI batch analysis |
| `test-connection` | renderer → main | AI provider connectivity check |
| `log-entry` | main → renderer | Real-time log streaming |

**Email & RSS push**
| Channel | Direction | Purpose |
|---|---|---|
| `push-email-load-config` / `push-email-save-config` | renderer ↔ main | Push config persistence (`data/email-push-config.json`) — contains both SMTP accounts and RSS settings |
| `push-email-test-smtp` | renderer → main | Test SMTP connection (supports draft config) |
| `push-email-crawl` | renderer → main | Crawl repos via GitHub Search, auto-analyze with AI, return repos with AI tags |
| `push-email-send` | renderer → main | Send HTML email via SMTP (`nodemailer`) to configured recipients |
| `push-rss-upload` | renderer → main | Generate RSS 2.0 XML and push to GitHub repo via Contents API (create or update file) |

**Prompt editor**
| Channel | Direction | Purpose |
|---|---|---|
| `load-all-prompts` | renderer → main | Returns all 16 prompt registry entries with current values and customization status |
| `save-prompt` | renderer → main | Save a single prompt override by key to `data/prompts.json` (appends to version history in `data/prompts-history.json`) |
| `reset-prompt` | renderer → main | Delete a single prompt override, reverting to hardcoded default |
| `get-prompt-history` | renderer → main | Fetch version history for a prompt key |
| `rollback-prompt` | renderer → main | Restore a prompt to a specific historical version |

**Auth**
| Channel | Direction | Purpose |
|---|---|---|
| `get-auth-status` | renderer → main | Check current GitHub auth state |
| `start-github-login` / `poll-github-token` | renderer → main | Device flow login |
| `login-with-github-pat` / `logout` | renderer → main | PAT login and logout |

**Presentation & recording**
| Channel | Direction | Purpose |
|---|---|---|
| `load-presentation-config` / `save-presentation-config` | renderer ↔ main | Presentation/TTS config persistence |
| `test-presentation-tts` | renderer → main | Test TTS audio generation |
| `select-presentation-manifest` | renderer → main | Native dialog to pick a playlist JSON |
| `prepare-presentation-session` | renderer → main | Build carousel HTML files (supports progress via `presentation-progress` push) |
| `open-readme-recorder` | renderer → main | Open fullscreen recorder window for carousel video capture |
| `save-recorded-video` | renderer → main | Save/transcode recorded WebM to MP4 via ffmpeg |
| `recorder-log` | renderer → main | Forward recorder process logs to main log emitter |

**Files & UI**
| Channel | Direction | Purpose |
|---|---|---|
| `select-repo-images` | renderer → main | Native multi-file image picker for a repo |
| `open-url` / `open-local-path` | renderer → main | Open external URL or local file/folder |
| `save-ai-config` / `load-ai-config` | renderer ↔ main | AI config persistence |
| Window controls | renderer → main | `minimize`, `maximize`, `close` (frameless window) |
| `close-current-window` | renderer → main | Close the calling BrowserWindow |

### Data Flow (primary path)
1. User sets search filters + AI config in UI
2. `App.jsx` calls `window.electronAPI.fetchRepos(config)` → IPC → `handleFetchRepos` → GitHub Search API
3. User optionally selects repos and fetches READMEs
4. User clicks "AI分析" → `window.electronAPI.analyzeRepos({ aiConfig, repos })` → `handleAnalyzeWithAI`
5. AI provider auto-selection: fastest successful connection test wins
6. Analysis results rendered in `AnalysisView` + persisted to `data/repo_analysis.json`

### Email & RSS Push Data Flow
1. User configures SMTP account(s), RSS feed settings (GitHub repo/branch/file path), crawl settings, and recipient list in `EmailPushPanel`
2. Config persisted to `data/email-push-config.json` via `push-email-save-config`
3. User triggers crawl → `push-email-crawl` → backend runs GitHub Search + AI analysis per account's crawl settings
4. Results open in `EmailPushEditor` overlay for manual review/edit before output
5a. **Email**: User clicks "发送邮件" → `push-email-send` → backend builds HTML email body (`buildEmailBody`) and sends via SMTP (`nodemailer`)
5b. **RSS**: User clicks "上传 RSS" → `push-rss-upload` → backend generates RSS 2.0 XML (`buildRssXml`), fetches existing file SHA from GitHub, then PUTs via Contents API. Public URL auto-computed: `.github.io` repos → `https://{repo}/{filePath}`, others → raw URL.

### Important Design Details
- Prompt resolution: `resolvePrompt(key, default)` in `ipc.js` loads overrides from `data/prompts.json` at startup. All hardcoded prompt constants use it. Template prompts store literal `${var}` placeholders substituted via `.replace()` at runtime. The `PromptEditorPanel` component provides the UI for editing all 16 prompts.
- AI provider detection: URL containing "anthropic" or "claude" uses the Anthropic route; everything else uses OpenAI-compatible format
- Structured AI output parsing has two passes: regex-based extraction from free text, then JSON extraction if available
- `resolveAutoPickModel` replaces reasoner models with chat models for DeepSeek (reasoner doesn't support structured output well)
- The frameless window has custom title bar controls (minimize/maximize/close IPC handlers)
- Sound effects use an Audio element pool (3 instances) with throttling (min interval per variant)
- Recorder data flow: `MediaRecorder` API in `recorder-preload.cjs` captures screen as WebM → `save-recorded-video` handler in `main.js` transcodes to MP4 via `ffmpeg-static`. The `asarUnpack` in `electron-builder.json` is required because ffmpeg can't run from within an asar archive
- `presentation-progress` is a main→renderer push channel (not an invoke), exposed via `onPresentationProgress` which returns an unsubscribe function
- Carousel HTML pages (`prompts/final_prompt.txt`) are AI-generated, single-page, 1920×1080 fixed-viewport documents with TTS-driven local image slideshow logic
- Font system: `index.html` preconnects to Google Fonts (Google Sans, Roboto, Noto Sans SC, Material Icons/Symbols). Carousel HTML uses base64-injected `htmlFont.ttf` from `data/fonts/` (also at `src/assets/htmlFont.ttf`) for offline rendering — the CSS font stack is `'Google Sans', 'Roboto', 'Noto Sans SC', 'htmlFont', system-ui, -apple-system, sans-serif`
- Page turn sound: the carousel plays `mixkit-fast-double-click-on-mouse-275.wav` from the project root on slide transitions
- RSS upload: `httpsRequest` accepts optional 4th arg `method` (defaults to `'POST'`, RSS uses `'PUT'`). `buildRssXml` generates RSS 2.0 XML with `escapeXml`/`toRfc822Date` helpers. `computeRssPublicUrl` auto-detects GitHub Pages vs raw URL from repo name. Upload requires GitHub PAT with `repo` scope — the existing auth token from `data/auth.json` is reused.
- Each account in `email-push-config.json` can have both SMTP fields and an `rssConfig` object — both channels coexist in one config, and the editor shows both output buttons when RSS is enabled.
