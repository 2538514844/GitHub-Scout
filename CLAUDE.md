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
- **antd** — UI component library

### Three-Layer Structure

**1. Electron main process** (`electron/main.js`)
- Creates frameless main window (1400x900, min 1000x700) and optional recorder window (fullscreen for README carousel video capture)
- Registers all IPC handlers — each handler delegates to a function in `electron/ipc.js`
- Log distribution: `logEmitter` (EventEmitter) sends log entries to renderer via `webContents.send('log-entry', ...)`

**2. Backend service layer** (`electron/ipc.js`, ~3700 lines)
All backend logic lives here. Key modules when read top-to-bottom:
- **Utility layer**: HTTP helpers (`httpsRequest`, `httpsGet`), JSON parsing, GitHub header builder
- **AI parsing**: Structured output extraction from AI responses (`extractOpenAiCompatibleMessage`, `parseStructuredRepoTagMap`, `parseStructuredRepoTagMapFromJson`) with retry logic and model fallback (e.g. DeepSeek reasoner → chat for structured output)
- **GitHub API**: Repo search (`fetchGitHub`, `handleFetchRepos`), README fetching (`fetchRepoReadme`, `handleFetchSelectedReadmes`), auth (device flow + PAT login)
- **README carousel**: Full HTML slideshow generation pipeline. The AI system prompt template lives in `prompts/final_prompt.txt` (~900 lines). Pipeline: AI narration → TTS audio via MiniMax API → local image injection → carousel index building → video recording with screen capture (WebM) → ffmpeg transcode to MP4 (4K, x264 CRF 18, AAC 320k)
- **AI analysis**: Multi-provider support (OpenAI-compatible as default, plus Anthropic route). Connection testing, repo batch analysis with progress reporting, structured tag/description output, history-aware analysis (reuses tags from similar past repos)
- **Data persistence**: JSON files in `data/` — `settings.json` (AI config), `auth.json` (GitHub token), `repo_analysis.json` (analysis history)
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

### Important Design Details
- AI provider detection: URL containing "anthropic" or "claude" uses the Anthropic route; everything else uses OpenAI-compatible format
- Structured AI output parsing has two passes: regex-based extraction from free text, then JSON extraction if available
- `resolveAutoPickModel` replaces reasoner models with chat models for DeepSeek (reasoner doesn't support structured output well)
- The frameless window has custom title bar controls (minimize/maximize/close IPC handlers)
- Sound effects use an Audio element pool (3 instances) with throttling (min interval per variant)
- Recorder data flow: `MediaRecorder` API in `recorder-preload.cjs` captures screen as WebM → `save-recorded-video` handler in `main.js` transcodes to MP4 via `ffmpeg-static`. The `asarUnpack` in `electron-builder.json` is required because ffmpeg can't run from within an asar archive
- `presentation-progress` is a main→renderer push channel (not an invoke), exposed via `onPresentationProgress` which returns an unsubscribe function
- Carousel HTML pages (`prompts/final_prompt.txt`) are AI-generated, single-page, 1920×1080 fixed-viewport documents with TTS-driven local image slideshow logic
