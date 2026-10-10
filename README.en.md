# ∞ Reading · 无限阅读

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.0-blue.svg)](CHANGELOG.md)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#architecture)
[![no build](https://img.shields.io/badge/build-none-brightgreen.svg)](#quick-start)

> Finite pages, infinite story.

An AI visual novel that never ends: you improvise the story with an LLM, and an AI painter draws each scene on the spot — with the prompt visible and editable.

**Pure front-end · no build · no dependencies · no backend.** Double-click `index.html` and you are playing. All data stays in your own browser.

**Current version: v0.2** ｜ Docs: [Architecture](ARCHITECTURE.md) · [Design (zh)](docs/DESIGN.md) · [Research & plan (zh)](docs/NOTES.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [中文说明](README.md)

## Features

- 🎭 **Improvise freely** — type anything, or pick one of the choices the AI offers.
- 🎨 **A painter that draws live** — the English prompt is visible and editable, and you can talk to the painter to revise the image.
- 🧭 **Three modes** — Story (choices), Chat, and Role-play (character card + relationship memory + user profile; imports SillyTavern V2/V3 cards).
- 🧠 **It remembers** — an explicit "world state card" plus on-demand recall and auto-compression at 70% of the context window, so long sessions don't forget.
- 📚 **Made to last** — story shelf, save points, `.irstory.json` import/export, and import of raw story text.
- 🔌 **Any model** — chat and image models are configured separately; any OpenAI-compatible endpoint works (cloud or local, set your own Base URL).
- 🎬 **Room left for video** — the adapter layer already reserves `VideoProviders` (async task APIs such as Kling / Vidu); not implemented yet.

## Try it without any setup

Don't want to paste an API key or set up a project first? **Append `?demo=1` to the URL and it starts playing:**

```
index.html?demo=1
```

A built-in 10-turn script plus locally drawn placeholder images (rendered with canvas): no network, no API cost, no configuration.
Story flow, choices, the painter sub-agent, image generation, the painter workbench, saving and the shelf all run through the *real* pipeline — only the model is replaced by a built-in script.

![Offline demo mode (?demo=1)](docs/screenshot.png)

- **Online demo**: `https://LiSheng5.github.io/infinite-reading/?demo=1` (enable it with Settings → Pages → Source: GitHub Actions; the workflow ships with the repo)
- **One file to carry around**: `npm run bundle` produces `dist/ir.html` (~380 KB with HTML/CSS/JS inlined) — send it as an attachment and double-click it
- To use a real model, drop the `?demo=1` from the URL (the little "🎬 演示" chip in the top bar does it for you) and configure a model from the home screen. Demo mode **never writes settings to storage**, so your real configuration stays untouched.

## Quick start

Grab a copy (or use **Code → Download ZIP** on the repo page, no git needed):

```bash
git clone git@github.com:LiSheng5/infinite-reading.git   # or https://github.com/LiSheng5/infinite-reading.git
cd infinite-reading
```

1. Run it — either way works:
   - Double-click `index.html` (pure front-end, no build, no dependencies)
   - Or serve it locally (more robust, recommended): `npx serve .` or `python -m http.server 8000`
2. Click **⚙ Connect a model** and fill in **Base URL** (pick from the dropdown or type your own), **API Key**, and **model name**. Image models are configured the same way.
3. **Click one of the three mode cards to start** — Story, Chat, or Role-play — there is no separate "Start" button; the premise box is always on screen and is only used by Story mode.
   - **📄 Import text**: hand over existing text (a setting document, a novel fragment, a chat log) and let the AI turn it into a starting premise.
   - **☰ My shelf** lists your stories (continue / rename / delete / export); **↶ Continue last** jumps straight back in.
   - Inside a story, the top-left `←` returns to the home screen, next to **☰ Shelf** and **＋ New story**.

> ⚠️ `file://` and `http://localhost` are two independent data stores — pick one and stick to it.
> Direct API calls from the browser may be blocked by CORS (especially under `file://`); if that happens, use a local static server.
> Only Base URLs are preset, never model names. Unsure parameters can be left empty or added to "custom request parameters" (`key=value`, merged into the request body as-is).
> Default image size is `1280x720`; change it if your provider complains.

## When images are generated

| Timing | Notes |
|---|---|
| After every turn | Most immersive, most expensive |
| After a choice (default) | Closest to a classic visual novel |
| Manual only | Cheapest |

In any mode you can also click **🎨 Draw** in the top-right to add an image manually.

## Data and backup

Everything lives in the **current browser's localStorage** (about 5MB). No server, no account, no upload.

**You will lose data permanently** if you: clear "cookies and site data", close an incognito window, switch browsers or devices, switch how you open the app (`file://` ⇄ `localhost`), or leave Safari untouched for 7 days. Clearing only the *cache* is fine. The app requests persistent storage on startup to reduce the risk of eviction.

**Backup**: *Model settings → Local storage & backup → Export everything* gives you an `.irbackup.json`; drop it back onto the shelf window to restore.

- API keys are excluded by default (you can opt in)
- Warning at 70% usage; reminder if you haven't backed up in 7 days
- A single story can be exported from its shelf card as `.irstory.json`

## Distribution (four ways)

| Way | Command / action | Good for |
|---|---|---|
| Local server | `npx serve .` (or `启动.bat` on Windows) | Daily use: avoids the `file://` CORS and storage split |
| Single file | `npm run bundle` → `dist/ir.html` (~390 KB) | Sharing: one HTML file, double-click and play |
| Online demo | GitHub Pages workflow ships with the repo | Zero install: `https://LiSheng5.github.io/infinite-reading/?demo=1` |
| Self-hosted | `docker compose up -d` → `http://localhost:8080/` | NAS / LAN / always-on (the container is stateless; data stays in each visitor's browser) |

**Installable (PWA)**: open it over `https` or `localhost` and the browser offers an install action — you get a desktop icon and offline launch. The Service Worker only caches same-origin static assets; **cross-origin API calls and your API key never enter any cache**.

**Icons**: `node tools/make-icons.mjs` regenerates `icons/` (vector plus PNGs, including a maskable and an iOS icon); the output is committed, so you never need to run it just to use the app.

## Architecture

```
player action ─► AI1 (story chat) ─► JSON: narration / choices / scene_change / world
                   │  may call the request_image tool
                   ▼
            painter sub-agent ─► JSON: prompt_en / subject / alt
                   ▼
            ImageProvider (/images/generations)
                   ▼
            background cross-fade + shelf / savepoints (localStorage, thumbnails)
```

| File | Role |
|---|---|
| `js/providers.js` | Adapter layer: `ChatProviders` / `ImageProviders`; `VideoProviders` reserved |
| `js/context.js` | Context assembly, compression chain, text import |
| `js/store.js` | Persistence (schema v2, legacy migration, shelf, save points) |
| `js/roleCard.js` | Character cards (SillyTavern PNG parsing) |
| `js/modelCapabilities.js` | Model parameter registry (empty by default) |
| `js/app.js` | State machine, image timing, settings, import/export |
| `js/demo.js` | Offline demo: registers the built-in script and placeholder-image adapters for `?demo=1` |
| `eval/run.js` | Offline evaluation (mock long game + probes, zero API cost) |
| `eval/demo-smoke.js` | Demo smoke test (contract checks, no browser needed) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for module duties, the full round-trip call chain, localStorage keys, and the invariants you must not break.

## Roadmap

**Delivered in v0.2 (2026-10-05)**: offline evaluation; world card and three modes; shelf and save points; painter workbench; style anchoring; tool recall; text import; role-play; data safety (persistent storage, 70% warning, one-click full backup).

**Open-source base + zero-install (2026-10-10)**: MIT license and community docs, single-source versioning, CI (syntax + version + offline eval + bundle smoke test), **offline demo `?demo=1`**, **single-file bundle**, GitHub Pages demo.

**Installable + distributable (2026-10-10)**: **PWA** (manifest + Service Worker, works offline; the cache name follows the version), icon generator (vector + PNGs incl. maskable / iOS), Windows **one-click `启动.bat`** (Python first, falls back to a dependency-free PowerShell server), **Dockerfile + compose** for self-hosting.

**Backlog**

- [ ] Move storage to IndexedDB; local folder / cloud-drive sync
- [ ] Image-to-image reference (character consistency)
- [ ] Video generation (Kling / Vidu)
- [ ] Character relationship graph
- [ ] Weighted retrieval for profile / relationship memory
- [ ] Extra character-card fields (`voice_samples` / `taboos` / `entity_synonyms`)
- [ ] Paper-white theme
- [ ] Text-to-speech
- [ ] Export a one-page short story

## Contributing and license

- **Code**: no `npm install` needed — edit `js/*.js`, refresh the browser. Please run `node eval/run.js` first (offline, no API cost). See [CONTRIBUTING.md](CONTRIBUTING.md) (in Chinese).
- **No code required**: `.irstory.json` stories, style packs, character cards, doc fixes and translations are all welcome.
- **Security**: report privately per [SECURITY.md](SECURITY.md); everything else goes to Issues (templates provided).
- **License**: [MIT](LICENSE). Third-party fonts and resources are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **Note**: API keys are stored in plain text in `localStorage` — don't save one on a shared device. The project collects and uploads nothing.
