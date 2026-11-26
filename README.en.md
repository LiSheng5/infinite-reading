# ∞ Reading · 无限阅读

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![version](https://img.shields.io/badge/version-0.14.0-blue.svg)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](#architecture)
[![built with Vite + Svelte](https://img.shields.io/badge/build-Vite%20%2B%20Svelte%205-blue.svg)](#quick-start)

> Finite pages, infinite story.

An AI visual novel that never ends: you improvise the story with an LLM, and an AI painter draws each scene on the spot — with the prompt visible and editable.

**Pure front-end · zero runtime dependencies · no backend.** Build it once (Vite + Svelte 5), then double-click the single-file output and you are playing. All data stays in your own browser.

**Current version: v0.14.0** ｜ Docs: [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [中文说明](README.md)

## Features

- 🎭 **Improvise freely** — type anything, or pick one of the choices the AI offers.
- 🎨 **A painter that draws live** — the English prompt is visible and editable, and you can talk to the painter to revise the image.
- 🧭 **Two modes** — Story (choices) and Chat. Chat is a tool-using assistant (draw, remember, schedule, draft email, buy — the last two only ever become proposals you confirm, and are off by default). Want to play a character? Add a card (SillyTavern V2/V3 import, relationship memory, user profile) — the card is optional; without one it is a plain assistant.
- 🧠 **It remembers** — an explicit "world state card" plus on-demand recall and auto-compression at 70% of the context window, so long sessions don't forget.
- 📚 **Made to last** — story shelf, save points, `.irstory.json` import/export, and import of raw story text.
- 🔌 **Any model** — chat and image models are configured separately; any OpenAI-compatible endpoint works (cloud or local, set your own Base URL).
- 🖼 **MiniMax image generation (`image-01` / `image-01-live`)** — pick **MiniMax native** in the image adapter to use the official `/v1/image_generation`; `image-01-live` supports four style presets (漫画 / 元气 / 中世纪 / 水彩 — manga / energetic / medieval / watercolor, via custom params like `style.style_type=漫画, style.style_weight=0.8`). If the browser is blocked by CORS, run `node tools/video-proxy.mjs` (one local relay process serves both image and video), base URL `http://127.0.0.1:4320`.
- 🖥 **ComfyUI local image generation (zero API cost)** — pick **ComfyUI local** in the image adapter, set the base URL to `http://127.0.0.1:8188`, and paste the workflow JSON exported from ComfyUI ("Export (API)") into settings. Each render only replaces the positive prompt, the random seed and the width/height; model, steps and the negative prompt all stay exactly as in your workflow. Start ComfyUI with `--enable-cors-header "*"` to allow browser access; renders may take up to 10 minutes.
- 🎯 **Consistent art style** — the painter writes each prompt on top of the previous image's full prompt as a "diff base" (style words kept verbatim, only the plot-driven part rewritten). With "reference = last image" enabled in settings, a JPEG of the previous image (long edge ≤ 1024) is also submitted as `subject_reference`, keeping faces and outfits coherent across scenes.
- 🎬 **Video (MiniMax)** — the 🎬 button on the story stage opens a small menu: "video from current image" / "video from the plot". The painter writes a motion prompt, a MiniMax async task runs on its own queue (10s polling, never blocks image generation), and the finished MP4 is stored in IndexedDB and played on stage. Reload or switch stories mid-run and the same task is picked up again. Uses the MiniMax V2 API (`MiniMax-H3` / `MiniMax-H3-Max`). If the browser is blocked by CORS, run `node tools/video-proxy.mjs` (a dependency-free local relay) and set the base URL to `http://127.0.0.1:4320`.

## Quick start

Grab a copy (or use **Code → Download ZIP** on the repo page, no git needed):

```bash
git clone git@github.com:LiSheng5/infinite-reading.git   # or https://github.com/LiSheng5/infinite-reading.git
cd infinite-reading
```

1. Build it (Node ≥ 24, the same major version CI runs; the source is ES modules + Svelte, so the repository root cannot be opened directly):

   ```bash
   npm ci
   npm run build        # dist/site (multi-file) + dist/single/index.html (single file)
   ```

   Then run it — either way works:
   - **Windows one-click**: double-click `启动.bat` — it builds first if there is no output, then serves on **`127.0.0.1` only** and opens your browser (Python if available, otherwise the bundled `tools/serve.ps1`: zero dependencies, with directory-traversal protection)
   - **Single file**: double-click `dist/single/index.html` (JS / CSS / icons all inlined into one HTML, `file://` works; `npm run bundle` copies it to `dist/ir.html`)
   - **Local server** (more robust, recommended): `python tools/serve.py` (bundled, offline, also loopback-only); with Node installed you can also use `npm run serve` (`npx serve`, a dev-only tool that downloads on first run and listens on **all interfaces** by default)
   - **Development**: `npm run dev` (Vite dev server with HMR; ship the built output)
2. **The connect wizard** (opens by itself on first launch; reopen it any time with **向导重新配置** next to the chat-model section in settings) walks four steps: **pick how to connect** (vendor preset — which only pre-fills the Base URL — your own URL, or aggregate mode) → **enter the API key** (stored in your browser only; requests go straight from the browser to the provider you picked, with no relay in between; local runtimes such as Ollama / LM Studio / vLLM skip this step) → **pick a model** (the list is fetched with `GET /models` and shown as a dropdown; if that fails just type the name — nothing is blocked) → **test the connection**. Every step also offers "skip and fill the full form instead" — the full settings form (including image / video / helper models) stays the advanced entry point. **Presets carry Base URLs only, never model names**: a model name comes from `GET /models` or from you, because vendors change them all the time and no built-in list can keep up.
   - **Aggregate mode (optional)** routes through an existing third-party aggregator (OpenRouter / SiliconFlow) — it is not a gateway you host: **your chat text and API key first pass through that aggregator's servers before being forwarded to the model vendor (browser → third party → vendor)**, so use it only if you accept that. While it is on, the chat-model section shows a persistent amber badge saying "conversations relayed via {operator}", with a one-click "switch back to direct".
   - Every **model** field in settings (story chat / model library / painter / scribe / drafter / image / video) auto-fills its `/models` list for the matching base URL; typing a name by hand always works.
3. **Click one of the two mode cards to start** — Story (uses the premise box) or Chat (a tool-using assistant: draw, remember, schedule, draft email, buy — the last two need your confirmation) — there is no separate "Start" button; the premise box is always on screen and is only used by Story mode. A new chat opens empty; its intro page offers an optional "add character card" entry.
   - **📄 Import text**: hand over existing text (a setting document, a novel fragment, a chat log) and let the AI turn it into a starting premise.
   - **☰ My shelf** lists your stories (continue / rename / delete / export); **↶ Continue last** jumps straight back in; the shelf's **＋ New** button also lets you pick a mode.
   - **Story mode is split-screen**: text on the left (narration is plain body copy; your own turns are quiet side-lines tagged 做 / 说 / 导演), the stage on the right (current image + thumbnails). **Chat is a pure chat layout** (no stage — images sit inline in the chat stream, click for a lightbox). The top-left `←` returns home next to the shelf and title; save points, new story, draw this scene and model settings live under the top-right `⋯`.
   - Above the input, **💡 灵感** keeps this turn's choices folded away (Story mode only) — open it for a row of options, or ignore it and type anything. The 做 / 说 / 导演 switch appears in Story mode only (chat has no such switch, with or without a card) and tells the model how to read your line; it is remembered per story.

> ⚠️ `file://` and `http://localhost` are two independent data stores — pick one and stick to it.
> Direct API calls from the browser may be blocked by CORS (especially under `file://`); if that happens, use a local static server.
> Only Base URLs are preset, never model names. Unsure parameters can be left empty or added to "custom request parameters" (`key=value`, merged into the request body as-is).
> Default image size is `1280x720`; change it if your provider complains.

## Drawing (on demand only)

**Story mode no longer generates images automatically** (since v0.11.0 — not even at the opening): when you want a picture, click **🎨** on the stage (or **⋯ → Draw this scene**). The painter reads the last few turns, decides what to draw, and writes the image back to the current scene; clicking again for the same scene does not queue duplicates. The painter workbench ("redraw" / "force redraw by style card") works as before.

In Chat, images still come from the model calling the image tool itself (it writes the prompt), or from the same manual button. The image tool is off by default (marked "testing"); turn it on under story settings → tools.

## Optional: local sidecar service (email / proactive scheduling / delegated purchase)

> 🧪 **Status: experimental (testing).** These three capabilities are still being validated; interfaces, config keys and behavior may change without notice, and backward compatibility is not guaranteed. **Feel free to skip this whole section**: `sidecar/` is a self-contained directory — if you don't start it and don't flip the switches, it never enters the main flow. The same goes for the four chat tools marked "testing" (image / schedule / email / purchase): they are all off by default and only affect that conversation.

> ⚠️ **Risk notice: AI makes mistakes. Set sensible limits.** All three capabilities ship **off by default**, with **0** limits and an **empty** allowlist — nothing goes through until you turn it on.

These three capabilities need an **optional** local service. Without it the app works as usual; the three entries just show "local service not started" and stay disabled:

```bash
node sidecar/server.mjs            # prints a token on first start
```

| Capability | What it does | Modes |
|---|---|---|
| Email | Draft / send email on your behalf; model-initiated mail stops at a **proposal card** (raw parameters visible) until you click "Confirm"; the **recipient allowlist is enforced server-side** (non-listed addresses only become drafts you must confirm); daily cap defaults to 0; every send / draft / rejection is audited | Chat |
| Proactive scheduling | Let the AI reach out on time (one-shot / fixed interval / cron with timezone); triggers survive restarts; **quiet hours and the daily cap live in the sidecar and cannot be changed by the model**; the model can only *propose* a trigger — you confirm it; one-click pause | Chat |
| Delegated purchase | The AI **never sees payment credentials**; it can only submit a purchase intent (again stopping at a **proposal card**), and the sidecar enforces policy in code (per-transaction / daily / monthly caps, merchant & category lists, cooldown, per-agent budgets). Above the threshold you get a confirmation dialog; the ledger is exportable as a receipt. This release only ships "mock" and "order only, you pay manually in your own payment app" | Chat |

Safety boundaries (see the "Security" section of `CONTRIBUTING.md` for details): the service binds **`127.0.0.1` only**, requires a local token, and refuses a second instance; the single source of truth for limits / allowlists / quiet hours / token is `sidecar/data/config.json`; the payment policy is there to **prevent mistakes and stay auditable, not to defend against you**; it **never automates or bypasses any payment app and never stores payment passwords**.

## Data and backup

Everything lives in the **current browser** (main store: IndexedDB, sized by the browser from free disk space — far beyond localStorage's ~5MB; original images are kept separately as Blobs). No server, no account, no upload.

**You will lose data permanently** if you: clear "cookies and site data", close an incognito window, switch browsers or devices, switch how you open the app (`file://` ⇄ `localhost`), or leave Safari untouched for 7 days. Clearing only the *cache* is fine. The app requests persistent storage on startup to reduce the risk of eviction.

**Backup**: *Model settings → Local storage & backup → Export everything* gives you two options; drop either file back onto the shelf window to restore:

- `.irbackup.json` — every story + settings + user profile, small and predictable; API keys excluded by default (opt-in)
- `.zip` — the same payload **plus all original images** (tick "also include original images"); images are stored as raw bytes, ~1/3 smaller than base64, so a new device gets the pictures too

- Warning at 70% usage; reminder if you haven't backed up in 7 days
- A single story can be exported from its shelf card as `.irstory.json` (optionally with images)

## Distribution (five ways)

| Way | Command / action | Good for |
|---|---|---|
| Local server | `启动.bat` on Windows, or `python tools/serve.py` | Daily use: avoids the `file://` CORS and storage split |
| Single file | `npm run bundle` → `dist/ir.html` (~700 KB) | Sharing: one HTML file, double-click and play |
| Online demo | GitHub Pages workflow ships with the repo | Zero install: `https://LiSheng5.github.io/infinite-reading/` |
| Self-hosted | `docker compose up -d` → `http://localhost:8080/` | NAS / LAN / always-on (the container is stateless; data stays in each visitor's browser) |
| Optional local service | `node sidecar/server.mjs` | Only if you want email / proactive scheduling / delegated purchase (Node ≥ 24 — needs the built-in `node:sqlite`; see `sidecar/README.md`) |

**Installable (PWA)**: open it over `https` or `localhost` and the browser offers an install action — you get a desktop icon and offline launch. The Service Worker only caches same-origin static assets; **cross-origin API calls and your API key never enter any cache**.

**Icons**: `node tools/make-icons.mjs` regenerates `icons/` (vector plus PNGs, including a maskable and an iOS icon); the output is committed, so you never need to run it just to use the app.

## Architecture

```
player action ─► AI1 (story chat) ─► JSON: narration / choices / scene_change / world
                   │
                   │   image entry points: user clicks 🎨 (the only one in Story mode) /
                   │   Chat may call request_image with its own prompt
                   ▼
            painter sub-agent ─► JSON: prompt_en / subject / alt (manual 🎨; direct calls skip it)
                   ▼
            ImageProvider (/images/generations)
                   ▼
            stage backdrop + shelf / savepoints (IndexedDB, thumbnails)
```

| File | Role |
|---|---|
| `src/main.js` | **Single entry**: app layer → screens → composition root → PWA, in dependency order (the old `src/legacy.js` is gone) |
| `src/core/providers.ts` | Adapter layer: `ChatProviders` / `ImageProviders` (`openai-images` generic-compatible · `minimax-image` official `/v1/image_generation` · `comfyui` local `/prompt` submit → poll → fetch) / `VideoProviders['minimax-video']` (MiniMax V2: `submit` / `poll` / `generate`) |
| `src/core/context.ts` | Context assembly, compression chain, text import |
| `src/core/tree.ts` | Branch-tree data layer: the turn tree is the single source of truth ("retry" adds a sibling, ‹ n/m › switches branches); log / world card and friends are projections of the root→head path |
| `src/core/storage.ts` | IndexedDB adapter (the only place that touches IndexedDB; falls back to localStorage without it) |
| `src/core/store.ts` | Persistence (memory-first + async flush; schema v3, legacy migration, shelf, save points) |
| `src/core/zip.ts` | Dependency-free hand-written ZIP: pack / unpack the full backup with original images |
| `src/core/roleCard.ts` | Character cards (SillyTavern PNG parsing) |
| `src/core/modelCapabilities.ts` | Context-window reference table (empty by default; vendor-specific params go through "extra request params") |
| `src/app/main.js` | Composition root: installs the modal shell, binds events, boots (business logic lives in the 25 modules under `src/app/` — see ARCHITECTURE.md §2.1) |
| `src/screens/` + `src/ui/` | Svelte 5 screens and the base component library (icons / buttons / modal card / view transitions) |
| `src/core/sidecar.ts` + `src/core/features.ts` (testing) | Optional local-service client: `/health` probe & offline fallback, proactive-message dedupe/queue |
| `src/pwa.js` + `sw.js` | PWA: registers the Service Worker; caches same-origin static assets only |
| `eval/run.js` | Offline evaluation (mock long game + probes, zero API cost) |
| `eval/tree-test.js` | Branch-tree data-layer tests (offline Node: projection / sibling switching / legacy migration / store integration) |
| `eval/proposals-test.js` | Proposal module tests (fake sidecar: model-initiated email / purchase can only produce a proposal, executes only after confirmation, idempotent / expiring, offline Node) |
| `eval/zip-smoke.js` etc. | ZIP smoke test and sidecar / frontend feature tests (all run by `npm test`) |
| `sidecar/` (testing) | Optional local service (Node process): email / proactive scheduling / delegated purchase; binds `127.0.0.1` only |
| `tools/` | Optional scripts: version sync, single-file bundle, icon generation, local server, `video-proxy.mjs` local relay for image/video generation (not runtime code) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for module duties, the full round-trip call chain, storage keys and backup formats, and the invariants you must not break.

## Contributing and license

- **Code**: `npm ci`, then `npm run dev` for development and `npm test` for the full offline suite (44 `eval/` gates + 3 `tools/` checks + `tsc`, 48 steps in total, zero API cost). See [CONTRIBUTING.md](CONTRIBUTING.md) (in Chinese).
- **No code required**: `.irstory.json` stories, style packs, character cards, doc fixes and translations are all welcome.
- **Security**: report privately per the "Security" section of [CONTRIBUTING.md](CONTRIBUTING.md); everything else goes to Issues (templates provided).
- **License**: [MIT](LICENSE). Third-party fonts and resources are listed in the "Third-party resources" section of [CONTRIBUTING.md](CONTRIBUTING.md).
- **Note**: API keys are stored in plain text in `IndexedDB` — don't save one on a shared device. The project collects and uploads nothing.
