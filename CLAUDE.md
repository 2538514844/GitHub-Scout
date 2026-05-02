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

# Batch dev startup (Windows) — convenience wrapper that cd's to project dir, runs electron:dev, pauses on error
启动.bat
```

- Vite standalone (`npm run dev`) runs on port 5290 with `strictPort: true`. For `electron:dev`, `scripts/electron-dev.js` auto-finds an available port starting at 5290 (up to 20 attempts), starts Vite with `--host 127.0.0.1`, waits up to 120s with `wait-on` (accepts HTTP 200-499), then spawns Electron. Both processes share the `VITE_DEV_SERVER_URL` env var. The script handles graceful shutdown (SIGINT/SIGTERM → kill Vite → exit).
- `index.html` is the Vite entry point (`<script type="module" src="/src/main.jsx">`). The app mounts inside `<React.StrictMode>` (React 19 double-mount in dev). It preconnects to Google Fonts for Google Sans, Roboto, Noto Sans SC, Material Icons, and Material Symbols Rounded.
- `vite.config.js` sets `base: './'` so built assets use relative paths — required for Electron's `file://` loading. Build output goes to `dist/`; electron-builder packages `dist/` + `electron/` + `package.json` into `release/`.
- `electron-builder.json`: `appId: "com.github-scout.app"`, `productName: "GitHub Scout"`, Windows-only portable build (`win.target: ["portable"]`), no custom icon (`win.icon: null`). No macOS or Linux targets.
- No test runner or linter is configured. If adding tests, use a lightweight setup consistent with React 19 + Vite.
- `concurrently` and `antd` are listed in devDependencies but not imported anywhere.

## Project Architecture

### Stack
- **Electron 34** — main process, IPC handlers, native dialogs, window management
- **React 19** — renderer in `src/`
- **Vite 6** — bundler via `@vitejs/plugin-react`
- **ffmpeg-static** — bundled ffmpeg binary for WebM→MP4 video transcoding (requires `asarUnpack` in electron-builder config)
- **nodemailer** — SMTP email delivery for the push system
- **@electron/get** — listed in devDependencies, used internally by electron-builder

### Three-Layer Structure

**1. Electron main process** (`electron/main.js`, ~470 lines)
- Creates frameless main window (1400x900, min 1000x700) and optional recorder window (fullscreen for README carousel video capture)
- Registers all IPC handlers — each handler delegates to a function in `electron/ipc.js`
- Log distribution: `logEmitter` (EventEmitter) sends log entries to renderer via `webContents.send('log-entry', ...)`
- Houses the WebM→MP4 ffmpeg transcode pipeline (`saveRecordedVideo` IPC handler) — relies on `ffmpeg-static` extracted outside the asar archive

**2. Backend service layer** (`electron/ipc.js`, ~4570 lines)
All backend logic lives here. Key modules when read top-to-bottom:
- **Utility layer**: HTTP helpers (`httpsRequest`, `httpsGet`), JSON parsing, GitHub header builder. Both HTTP helpers now include `withNetworkRetry` (retries ECONNRESET/ETIMEDOUT/etc. up to 2 times with backoff) and set `rejectUnauthorized: false` for compatibility with certain network environments.
- **AI parsing**: Structured output extraction from AI responses (`extractOpenAiCompatibleMessage`, `parseStructuredRepoTagMap`, `parseStructuredRepoTagMapFromJson`) with retry logic and model fallback (e.g. DeepSeek reasoner → chat for structured output)
- **GitHub API**: Repo search (`fetchGitHub`, `handleFetchRepos`), README fetching (`fetchRepoReadme`, `handleFetchSelectedReadmes`), auth (device flow + PAT login)
- **README carousel**: Full HTML slideshow generation pipeline. The AI system prompt template lives in `prompts/final_prompt.txt` (~900 lines). Pipeline: AI narration → TTS audio via MiniMax API → local image injection → carousel index building → video recording with screen capture (WebM) → ffmpeg transcode to MP4 (4K, x264 CRF 18, AAC 320k)
- **AI analysis**: Multi-provider support (OpenAI-compatible as default, plus Anthropic route). Connection testing, repo batch analysis with progress reporting, structured tag/description output, history-aware analysis (reuses tags from similar past repos)
- **Email & RSS push**: Crawl repos via GitHub Search, auto-analyze with AI, then output via two channels — (1) bulk-send curated repo lists as HTML email via SMTP (`nodemailer`), (2) auto-upload RSS 2.0 XML to a GitHub repo via the Contents API for RSS reader subscription. Both SMTP and RSS settings are **global** — configured once and shared across all accounts. Each account keeps its own name, recipients, and crawl config. Before sending, AI generates 20-50 char per-repo intros via `rssItemIntroPrompt`/`emailItemIntroPrompt` prompts for more engaging descriptions.
- **Global SMTP**: `data/email-push-config.json` stores a top-level `smtp` object with host/port/user/pass/useTls shared across all push accounts. Old per-account SMTP fields are auto-migrated on first load. IPC channels: `push-global-smtp-load`, `push-global-smtp-save`, `push-global-smtp-test`.
- **Global RSS**: `data/email-push-config.json` stores a top-level `rss` object with enabled/repo/branch/filePath/fileMode/commitMessage/title/description/link/publicUrl/maxItems. Old per-account RSS configs are auto-migrated on first load. IPC channels: `push-global-rss-load`, `push-global-rss-save`, `push-global-rss-upload`. Global RSS upload pushes repos to the configured GitHub repo via Contents API. Supports two `fileMode`s: **dated** (each upload creates a separate `{date}.xml` file, auto-generates an `index.html` directory page) and **merge** (consolidates items into one file, capped at `maxItems`). Both modes deduplicate by guid when merging with existing RSS content.
- **Prompt overrides**: `resolvePrompt(key, default)` checks `data/prompts.json` for user overrides before falling back to hardcoded defaults. All 18 prompt registry entries use this. Template prompts store literal `${var}` placeholders substituted via `.replace()` at runtime. `prompts.json` and `prompts-history.json` are created on first save via the Prompt Editor UI; they do not exist in a fresh clone. Each save appends a version history entry in `prompts-history.json`, supporting per-prompt rollback.
- **Data persistence**: JSON files in `data/` — `settings.json` (AI config), `auth.json` (GitHub token), `repo_analysis.json` (analysis history), `email-push-config.json` (SMTP accounts, recipients, crawl settings), `prompts.json` (AI prompt overrides, created on first save), `prompts-history.json` (version history per prompt key, created on first save), `presentation-settings.json` (TTS config + playlist), `logs/` (daily log files: `app-YYYY-MM-DD.log`), `tts-cache/` (cached TTS audio), `readme-carousel-runs/` (generated carousel HTML sessions), `fonts/` (single `htmlFont.ttf` base64 font for offline carousel rendering, also at `src/assets/htmlFont.ttf`)
- **Atomic writes**: JSON save functions in `ipc.js` and `presentation.js` use tmp-file + backup + rename to avoid corruption on write failure.
- **Video transcode**: `main.js` includes a WebM→MP4 ffmpeg pipeline using `ffmpeg-static`. `electron-builder.json` has `asarUnpack` for `node_modules/ffmpeg-static/**/*` — ffmpeg can't run from within an asar archive

**`electron/presentation.js`** (~750 lines) — Standalone TTS and slideshow manager:
- MiniMax TTS API integration with local audio caching (`data/tts-cache/`), with network retry built into `httpsPostJson`
- WAV/MP3 duration estimation for audio synchronization
- Playlist parsing and carousel HTML generation; preserves `audioPath` and `audioDurationMs` when reusing cached TTS
- Manifest loading for stored presentation sessions
- Exports `findLatestCarouselManifest` and `buildPlaylistFromCarouselManifest` for loading the most recent carousel session as a playlist
- Atomic JSON writes with backup (`writeJsonFile` writes to .tmp, backs up old file, then renames)
- `repoFooterFontSize` config field controls carousel footer text size (default 14px)

**`electron/local-image-runtime.js`** — Small utility injecting CSS for local image modals in README HTML

**`electron/recorder-preload.cjs`** — Screen recording preload script injected into the recorder window. Uses `MediaRecorder` API with auto-format detection, overlay UI for record/stop/save controls.

**3. React renderer** (`src/`)

| Component | Purpose |
|---|---|
| `App.jsx` | Main orchestrator — state for repos, analysis, AI config, auth, logs, sidebar navigation. Uses `activeSidebarTab` (null/'config'/'email-push'/'smtp'/'rss'/'prompts'/'presentation'/'repo-history') instead of individual toggle booleans. |
| `Sidebar.jsx` | Left sidebar with nav items (AI配置/个人推送/SMTP设置/RSS设置/固定播放器/历史仓库/提示词). Only one panel active at a time. |
| `ConfigPanel.jsx` | AI provider configuration (base URL, API key, model) with presets for OpenAI, Claude, SiliconFlow, DeepSeek, Zhipu, Ollama, Custom. Includes connection test button. |
| `RepoTable.jsx` | Displays fetched repos in a table with selection, CSV export |
| `RepoImagePanel.jsx` | Local image picker/manager per repo |
| `AnalysisView.jsx` | Renders AI analysis output as styled HTML (markdown-like → DOM with clickable repo/external links) |
| `Auth.jsx` | GitHub login (PAT) and logout UI |
| `LogPanel.jsx` | Dead code — not imported by any component. `App.jsx` renders log tabs inline. |
| `PresentationStudio.jsx` | Presentation/TTS configuration and playlist editing UI |
| `PresentationPlayerOverlay.jsx` | In-app player overlay for carousel preview (rendered as child of `PresentationStudio`, not by `App.jsx` directly) |
| `GlobalSmtpSettings.jsx` | Global SMTP settings form (host, port, user, pass, TLS) shared across all push accounts. Test connection + save. |
| `GlobalRssSettings.jsx` | Global RSS settings form (enabled, repo, branch, filePath, commitMessage, title, description, link, publicUrl). Save only — RSS push happens in the editor overlay. |
| `EmailPushPanel.jsx` | Push account management — account name, recipient list, crawl settings (keywords, date range, stars, pages). SMTP and RSS are now global via separate settings panels. |
| `EmailPushEditor.jsx` | Full-screen overlay for reviewing/editing crawled repos before output — checkbox selection, inline editing, "发送邮件" to SMTP recipients, "全局 RSS" to push to global RSS feed |
| `PromptEditorPanel.jsx` | Visual editor for all AI prompt templates — browse by category, search, edit with monospace textarea, save/reset per prompt |
| `RepoHistoryPanel.jsx` | Searchable history of all crawled repos from `data/repo_analysis.json`. Shows tags as chips, stars/forks, and a "车播" badge if the repo was used in a README carousel. Supports pagination via `load-repo-history` IPC. |
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
| `load-repo-history` | renderer → main | Load paged historical repos from `repo_analysis.json` enriched with `hasCarousel` flag (cross-references carousel manifests) |

**Global SMTP** (shared across all push accounts)
| Channel | Direction | Purpose |
|---|---|---|
| `push-global-smtp-load` / `push-global-smtp-save` | renderer ↔ main | Global SMTP config (host/port/user/pass/useTls) in `data/email-push-config.json` |
| `push-global-smtp-test` | renderer → main | Test global SMTP connection independently of any account |

**Global RSS** (shared across all push accounts)
| Channel | Direction | Purpose |
|---|---|---|
| `push-global-rss-load` / `push-global-rss-save` | renderer ↔ main | Global RSS config (enabled/repo/branch/filePath/commitMessage/title/description/link/publicUrl) |
| `push-global-rss-upload` | renderer → main | Upload RSS XML to global repo (with AI intros). Dated mode: new file per upload + auto-regenerate `index.html` directory. Merge mode: consolidate into single file, dedup by guid |

**Email & RSS push**
| Channel | Direction | Purpose |
|---|---|---|
| `push-email-load-config` / `push-email-save-config` | renderer ↔ main | Push config persistence (`data/email-push-config.json`) — contains global `smtp`, `accounts[]` (name, recipients, crawlConfig, rssConfig) |
| `push-email-test-smtp` | renderer → main | Test SMTP connection with given config (used by global SMTP panel) |
| `push-email-crawl` | renderer → main | Crawl repos via GitHub Search, auto-analyze with AI, return repos with AI tags |
| `push-email-send` | renderer → main | Send HTML email via SMTP (`nodemailer`) using global SMTP config + per-account recipients. Generates AI intros per repo via `emailItemIntroPrompt` before sending |
| `push-rss-upload` | renderer → main | Generate RSS 2.0 XML (with AI intros via `rssItemIntroPrompt`) and push to GitHub repo via Contents API (create or merge with existing items, dedup by guid) |

**Prompt editor**
| Channel | Direction | Purpose |
|---|---|---|
| `load-all-prompts` | renderer → main | Returns all 18 prompt registry entries with current values and customization status |
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
| `load-latest-carousel-manifest` | renderer → main | Load the most recent carousel manifest as a playlist JSON |
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
1. User configures global SMTP (`GlobalSmtpSettings`) and global RSS (`GlobalRssSettings`) via sidebar panels — persisted to `data/email-push-config.json` as top-level `smtp` and `rss` objects
2. User creates push accounts in `EmailPushPanel` (account name, crawl settings, recipients) — stored in `accounts[]` array
3. User triggers crawl → `push-email-crawl` → backend runs GitHub Search + AI analysis per account's crawl settings
4. Results open in `EmailPushEditor` overlay for manual review/edit before output
5a. **Email**: User clicks "发送邮件" → `push-email-send` → backend uses global SMTP + per-account recipients, builds HTML email body (`buildEmailBody`) and sends via `nodemailer`
5b. **RSS**: User clicks "全局 RSS" or per-account RSS → backend first generates AI intros per repo (`generateRepoIntros` with `rssItemIntroPrompt`), then builds RSS 2.0 XML (`buildRssXmlFromConfig` or `buildRssXml`), fetches existing file SHA and parses existing items for dedup, then PUTs via Contents API. In `dated` mode, creates a date-stamped file (`{date}.xml`) and auto-publishes an `index.html` directory page listing all feed files. In `merge` mode, consolidates new + existing items into one file capped at `maxItems`. Public URL auto-computed: `.github.io` repos → `https://{repo}/{filePath}`, others → raw URL.

### Important Design Details

**AI & Prompts**
- Prompt resolution: `resolvePrompt(key, default)` in `ipc.js` loads overrides from `data/prompts.json` at startup. All hardcoded prompt constants use it. Template prompts store literal `${var}` placeholders substituted via `.replace()` at runtime. The `PromptEditorPanel` component provides the UI for editing all 18 prompts.
- AI provider detection: URL containing "anthropic" or "claude" uses the Anthropic route; everything else uses OpenAI-compatible format
- Structured AI output parsing has two passes: regex-based extraction from free text, then JSON extraction if available
- `resolveAutoPickModel` replaces reasoner models with chat models for DeepSeek (reasoner doesn't support structured output well)

**Presentation & Recording**
- Carousel HTML pages are AI-generated via `prompts/final_prompt.txt` (~900 lines) — single-page, 1920×1080 fixed-viewport documents with TTS-driven local image slideshow logic
- `presentation-progress` is a main→renderer push channel (not an invoke), exposed via `onPresentationProgress` which returns an unsubscribe function
- Font system: `index.html` preconnects to Google Fonts. Carousel HTML uses base64-injected `htmlFont.ttf` from `data/fonts/` (also at `src/assets/htmlFont.ttf`) for offline rendering — CSS font stack: `'Google Sans', 'Roboto', 'Noto Sans SC', 'htmlFont', system-ui, -apple-system, sans-serif`
- Page turn sound: the carousel plays `mixkit-fast-double-click-on-mouse-275.wav` from the project root on slide transitions
- Recorder data flow: `MediaRecorder` API in `recorder-preload.cjs` captures screen as WebM → `save-recorded-video` handler in `main.js` transcodes to MP4 via `ffmpeg-static` (4K, x264 CRF 18, AAC 320k). The `asarUnpack` in `electron-builder.json` is required because ffmpeg can't run from within an asar archive

**RSS & Email Push**
- SMTP and RSS settings are **global** (top-level `smtp` and `rss` objects in `email-push-config.json`), not per-account. Old per-account SMTP/RSS fields are auto-migrated to the top level on first load. Each account in `accounts[]` stores only name, recipients, and crawlConfig.
- RSS upload: `httpsRequest` accepts optional 4th arg `method` (defaults to `'POST'`, RSS uses `'PUT'`). `buildRssXml` and `buildRssXmlFromConfig` generate RSS 2.0 XML with `buildRssItemXml`/`escapeXml`/`toRfc822Date` helpers. Both upload paths now merge with existing RSS items (deduplication by guid) and can generate AI-powered per-repo intros. `computeRssPublicUrl` auto-detects GitHub Pages vs raw URL from repo name. Upload requires GitHub PAT with `repo` scope — the token from `data/auth.json` is read as `auth.accessToken` (not `auth.token`).

**UI**
- The frameless window has custom title bar controls exposed via IPC (`minimize`/`maximize`/`close`). Recorder windows also expose `close-current-window`
- Sound effects use an Audio element pool (3 instances) with throttling (min interval per variant)
- Sidebar navigation: `App.jsx` uses a single `activeSidebarTab` state instead of individual `showConfig`/`showEmailPush`/`showPromptEditor` booleans. `Sidebar.jsx` renders the nav + content slot. Clicking a nav item toggles the panel; clicking the active item closes the sidebar. Header has a single "侧栏" hamburger button replacing the old AI配置/个人推送/提示词 individual toggles.
- **Icons**: In React components, always use Google Material Icons (classic `material-icons` font) — do NOT use `material-symbols-rounded` in JSX. The font is preloaded in `index.html` via `<link href="https://fonts.googleapis.com/icon?family=Material+Icons">`. Usage: `<span className="material-icons" style={{ fontSize: 14 }}>icon_name</span>`. Variable fonts (Material Symbols) require `font-variation-settings` that won't work without extra CSS in the React renderer. However, **backend-generated HTML** (email body in `ipc.js`, carousel pages) uses `material-symbols-rounded` via its own `<link>` — that is acceptable since those are standalone HTML documents, not React components. For new static HTML (email body, RSS), include the appropriate Google Fonts link in `<head>`. Current icon mapping in the project:

| Context | Icon Name | Meaning |
|---|---|---|
| Sidebar | `tune` | AI 配置 |
| Sidebar | `mail` | 个人推送 |
| Sidebar | `send` | SMTP 设置 |
| Sidebar | `rss_feed` | RSS 设置 |
| Sidebar | `edit_note` | 提示词 |
| Sidebar | `slideshow` | 固定播放器 |
| Sidebar | `history` | 历史仓库 |
| Data labels | `star` | Stars |
| Data labels | `call_split` | Forks (git branch icon) |
