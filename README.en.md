# ∞ Reading · 无限阅读

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#architecture)
[![no build](https://img.shields.io/badge/build-none-brightgreen.svg)](#quick-start)

> Finite pages, infinite story.

An AI visual novel that never ends: you improvise the story with an LLM, and an AI painter draws each scene on the spot — with the prompt visible and editable.

**Pure front-end · no build · no dependencies · no backend.** Double-click `index.html` and you are playing. All data stays in your own browser.

**Current version: v0.3** ｜ Docs: [Architecture](ARCHITECTURE.md) · [Design (zh)](docs/DESIGN.md) · [Research & plan (zh)](docs/NOTES.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [中文说明](README.md)

## Features

- 🎭 **Improvise freely** — type anything, or pick one of the choices the AI offers.
- 🎨 **A painter that draws live** — the English prompt is visible and editable, and you can talk to the painter to revise the image.
- 🧭 **Three modes** — Story (choices), Chat, and Role-play (character card + relationship memory + user profile; imports SillyTavern V2/V3 cards).
- 🧠 **It remembers** — an explicit "world state card" plus on-demand recall and auto-compression at 70% of the context window, so long sessions don't forget.
- 📚 **Made to last** — story shelf, save points, `.irstory.json` import/export, and import of raw story text.
- 🔌 **Any model** — chat and image models are configured separately; any OpenAI-compatible endpoint works (cloud or local, set your own Base URL).
- 🎬 **Offline demo** — append `?demo=1` to run the whole flow without a key or a network (built-in script + locally drawn placeholder images).
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
- **One file to carry around**: `npm run bundle` produces `dist/ir.html` (~530 KB with HTML/CSS/JS inlined) — send it as an attachment and double-click it
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

## Optional: local sidecar service (email / proactive scheduling / delegated purchase)

> ⚠️ **Risk notice: AI makes mistakes. Set sensible limits.** All three capabilities ship **off by default**, with **0** limits and an **empty** allowlist — nothing goes through until you turn it on.

These three capabilities need an **optional** local service. Without it the app works as usual; the three entries just show "local service not started" and stay disabled:

```bash
node sidecar/server.mjs            # prints a token on first start
```

| Capability | What it does | Only in chat / role-play mode |
|---|---|---|
| Email | Draft / send email on your behalf; the **recipient allowlist is enforced server-side** (non-listed addresses only become drafts you must confirm); daily cap defaults to 0; every send / draft / rejection is audited | yes |
| Proactive scheduling | Let the AI reach out on time (one-shot / fixed interval / cron with timezone); triggers survive restarts; **quiet hours and the daily cap live in the sidecar and cannot be changed by the model**; the model can only *propose* a trigger — you confirm it; one-click pause | yes |
| Delegated purchase | The AI **never sees payment credentials**; it can only submit a purchase intent, and the sidecar enforces policy in code (per-transaction / daily / monthly caps, merchant & category lists, cooldown, per-agent budgets). Above the threshold you get a confirmation dialog; the ledger is exportable as a receipt. This release only ships "mock" and "order only, you pay manually in your own payment app" | yes |

Safety boundaries (see `SECURITY.md` for details): the service binds **`127.0.0.1` only**, requires a local token, and refuses a second instance; the single source of truth for limits / allowlists / quiet hours / token is `sidecar/data/config.json`; the payment policy is there to **prevent mistakes and stay auditable, not to defend against you**; it **never automates or bypasses any payment app and never stores payment passwords**.

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
| Local server | `npx serve .` (or `启动.bat` on Windows) | Daily use: avoids the `file://` CORS and storage split |
| Single file | `npm run bundle` → `dist/ir.html` (~530 KB) | Sharing: one HTML file, double-click and play |
| Online demo | GitHub Pages workflow ships with the repo | Zero install: `https://LiSheng5.github.io/infinite-reading/?demo=1` |
| Self-hosted | `docker compose up -d` → `http://localhost:8080/` | NAS / LAN / always-on (the container is stateless; data stays in each visitor's browser) |
| Optional local service | `node sidecar/server.mjs` | Only if you want email / proactive scheduling / delegated purchase (Node ≥ 22) |

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
            background cross-fade + shelf / savepoints (IndexedDB, thumbnails)
```

| File | Role |
|---|---|
| `js/providers.js` | Adapter layer: `ChatProviders` / `ImageProviders`; `VideoProviders` reserved |
| `js/context.js` | Context assembly, compression chain, text import |
| `js/storage.js` | IndexedDB adapter (the only place that touches IndexedDB; falls back to localStorage without it) |
| `js/store.js` | Persistence (memory-first + async flush; schema v2, legacy migration, shelf, save points) |
| `js/zip.js` | Dependency-free hand-written ZIP: pack / unpack the full backup with original images |
| `js/roleCard.js` | Character cards (SillyTavern PNG parsing) |
| `js/modelCapabilities.js` | Model parameter registry (empty by default) |
| `js/app.js` | State machine, image timing, settings, import/export |
| `js/demo.js` | Offline demo: registers the built-in script and placeholder-image adapters for `?demo=1` |
| `js/sidecar.js` + `js/features.js` | Optional local-service client: `/health` probe & offline fallback, proactive-message dedupe/queue |
| `js/pwa.js` + `sw.js` | PWA: registers the Service Worker; caches same-origin static assets only |
| `eval/run.js` | Offline evaluation (mock long game + probes, zero API cost) |
| `eval/demo-smoke.js` | Demo smoke test (contract checks, no browser needed) |
| `eval/zip-smoke.js` etc. | ZIP smoke test and sidecar / frontend feature tests (all run by `npm test`) |
| `sidecar/` | Optional local service (Node process): email / proactive scheduling / delegated purchase; binds `127.0.0.1` only |
| `tools/` | Optional scripts: version sync, single-file bundle, icon generation, local server (not runtime code) |

See [ARCHITECTURE.md](ARCHITECTURE.md) for module duties, the full round-trip call chain, storage keys and backup formats, and the invariants you must not break.

## Roadmap

**Delivered in v0.2 (2026-10-05)**: offline evaluation; world card and three modes; shelf and save points; painter workbench; style anchoring; tool recall; text import; role-play; data safety (persistent storage, 70% warning, one-click full backup).

**Open-source base + zero-install (2026-10-10)**: MIT license and community docs, single-source versioning, CI (syntax + version + offline eval + bundle smoke test), **offline demo `?demo=1`**, **single-file bundle**, GitHub Pages demo.

**Installable + distributable (2026-10-10)**: **PWA** (manifest + Service Worker, works offline; the cache name follows the version), icon generator (vector + PNGs incl. maskable / iOS), Windows **one-click `启动.bat`** (Python first, falls back to a dependency-free PowerShell server), **Dockerfile + compose** for self-hosting.

**v0.3 — capacity & mobile (2026-10-10)**: **storage migrated to IndexedDB** (memory-first + async persistence, same story schema and call signatures; one-time migration from localStorage with verification, idempotency and safe fallback), **originals stored as Blobs** instead of base64 text, real usage/quota readout and orphan-image cleanup, a **"Test connection" button** (reachability probe only — costs nothing), **no offline queueing** (offline image requests are simply not sent), **full backup with original images** (one click → `.zip` carrying every story plus its pictures; dependency-free hand-written ZIP, see `js/zip.js`), and mobile polish (safe areas, 44px touch targets).

**Backlog**

- [ ] Local folder / cloud-drive sync (IndexedDB landed in v0.3)
- [ ] Image-to-image reference (character consistency)
- [ ] Video generation (Kling / Vidu)
- [ ] Character relationship graph
- [ ] Weighted retrieval for profile / relationship memory
- [ ] Extra character-card fields (`voice_samples` / `taboos` / `entity_synonyms`)
- [ ] Paper-white theme
- [ ] Text-to-speech
- [ ] Export a one-page short story
- [ ] Bundled fonts (subset locally — faster first paint, no CDN)
- [ ] Desktop app (Tauri 2: smaller footprint, OS keychain for API keys)
- [ ] macOS / Linux one-click start scripts
- [ ] Content repository (`.irstory.json` / style packs / character cards) + format schema + curated gallery

## Contributing and license

- **Code**: no `npm install` needed — edit `js/*.js`, refresh the browser. Please run `node eval/run.js` first (offline, no API cost). See [CONTRIBUTING.md](CONTRIBUTING.md) (in Chinese).
- **No code required**: `.irstory.json` stories, style packs, character cards, doc fixes and translations are all welcome.
- **Security**: report privately per [SECURITY.md](SECURITY.md); everything else goes to Issues (templates provided).
- **License**: [MIT](LICENSE). Third-party fonts and resources are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **Note**: API keys are stored in plain text in `IndexedDB` — don't save one on a shared device. The project collects and uploads nothing.
