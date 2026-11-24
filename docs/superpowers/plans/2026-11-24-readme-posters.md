# README Posters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four loud, real-UI posters at the top of the GitHub README, released as 5.9.4.

**Architecture:** The real side panel (`sidepanel.html` scripts + `sidepanel.css`) is loaded in `docs/posters/panel.html`
with a stubbed `chrome` API that serves sample data per "scene". Four poster pages embed that panel (iframe) plus
headline type and pop-out elements, and `scripts/posters.sh` renders them to PNG with the local headless Chrome.

**Tech Stack:** Plain HTML/CSS/JS, Google Chrome headless (`/Applications/Google Chrome.app`), bash.

**Spec:** `docs/superpowers/specs/2026-11-24-readme-posters-design.md`

## Global Constraints
- Posters are English; headlines 2–4 words, key word big + italic.
- Order and colors: 1 hero orange "Record once. *Replay* with new values." · 2 dark "Clicks → an *AI prompt*." ·
  3 dark "Your UI test, *already written*." · 4 orange "Group. *Share*. Import."
- Hero 2:1 (1600×800 CSS px); posters 2–4 are 3:4 (900×1200 CSS px) and read as one panorama strip.
- Rendered at device scale factor 2; PNGs in `docs/images/`, sources in `docs/posters/`.
- Only real panel UI; no invented screens. No changes to extension code.
- `scripts/package.sh` excludes `docs/`. Never touch the `key` in `manifest.json`.
- Release per CLAUDE.md: patch 5.9.4, CHANGELOG section, README section.

## Review Focus
- GitHub on a phone shows the 3-poster strip at ~110 px each: headline cap height must stay ≥ 8% of poster width.
- GitHub dark theme: PNGs must have an opaque background (no transparency) so edges don't vanish.
- A stub gap makes `sidepanel.js` throw and the panel renders empty without notice: rendering must fail on any page error.
- Fonts not loaded before capture → fallback font in PNG: capture waits for `document.fonts.ready`.
- Extension zip must not grow: no `docs/` paths in `dist/ActionRecorder-v5.9.4.zip`.

---

### Task 1: Real panel with sample scenes

**Files:**
- Generate: `docs/posters/panel.html` — built by `scripts/posters.sh` from `sidepanel.html` so the markup stays
  identical (sed: rewrite `href="sidepanel.css"` → `href="../../sidepanel.css"`, `src="X.js"` → `src="../../X.js"`,
  and insert `<script src="stub.js"></script><script src="scenes.js"></script>` before `format.js`). Generated, git-ignored.
- Create: `docs/posters/stub.js` — `window.chrome` with `storage.local.get/set`, `storage.onChanged.addListener`,
  `runtime.getManifest` (reads version from a constant set by the script), `runtime.sendMessage` (resolves `{}`),
  `tabs.query/get`, `scripting.executeScript`, `notifications.*` — all no-op promises. `get()` returns `SCENES[scene]`
  where `scene = new URLSearchParams(location.search).get('scene')`. Also `window.onerror` → set `document.title = 'ERROR: ' + msg`.
- Create: `docs/posters/scenes.js` — `const SCENES = { rec, flows, test }`, each a full storage object
  (`{...DEFAULTS-shaped state, flows, envs, groups}`) plus `view` to open (`rec` | `flows`).
  - `rec`: a stopped recording of ~7 steps on a realistic admin site (nav, click "New order", type {{customer}},
    select {{plan}}, click "Save", a check step), with `vars: [{name:'customer'},{name:'plan'}]`.
  - `flows`: 3 groups ("Onboarding", "Billing", "Smoke tests"), 6 saved flows.
  - `test`: one flow containing a 🧪 test step with expected result and 2 conditions.
- Modify: `.gitignore` — add `docs/posters/panel.html`.

**Interfaces:** Produces `docs/posters/panel.html?scene=rec|flows|test`, 380×720 CSS px panel; `SCENES` global.

- [ ] **Step 1:** Generate `panel.html` (the sed from `scripts/posters.sh`, Task 3, can be written now as its first function `make_panel`).
- [ ] **Step 2:** For each scene run
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --allow-file-access-from-files --virtual-time-budget=3000 --dump-dom "file://$PWD/docs/posters/panel.html?scene=rec"`
  Expected: `<title>` does not start with `ERROR:`; `rec` dump contains ≥ 7 `<li` inside `id="steps"`; `flows` dump contains the 3 group names.
- [ ] **Step 3:** Screenshot each scene at 380×720 into the scratchpad and look at it; fix sample data until rows look like a real recording (labels, variables highlighted, no "undefined").
- [ ] **Step 4: Commit** `docs/posters/stub.js docs/posters/scenes.js .gitignore scripts/posters.sh` — "Posters: real side panel with sample scenes".

### Task 2: Four poster layouts

**Files:**
- Create: `docs/posters/poster.css` — tokens: `--orange: #FF5A1F`, `--ink: #111111`, `--paper: #FFF4EC`,
  headline font "Inter Tight" 800 (Google Fonts) with italic key word in "Instrument Serif" italic; headline size
  ≥ 11% of poster width.
- Create: `docs/posters/1-replay.html` (1600×800, orange): panel iframe `scene=rec` tilted −6°, bleeding off the
  bottom edge; pop-outs: a variables card `customer = Acme Ltd · plan = Pro` and a "▶ Replay" pill crossing the panel edge.
- Create: `docs/posters/2-prompt.html` (900×1200, dark): panel `scene=rec` tilted, an arrow into a Markdown card whose
  text is `toMarkdown(SCENES.rec)` from `format.js` (first ~14 lines, monospace), card overlapping the right edge.
- Create: `docs/posters/3-test.html` (900×1200, dark): panel `scene=test`; pop-out "✓ 2 / 2 checks passed" report chip;
  left edge continues the Markdown card from poster 2 (panorama join).
- Create: `docs/posters/4-share.html` (900×1200, orange): panel `scene=flows`; pop-outs: `.json` file chip and
  "Import" pill; left edge continues the chip from poster 3.
- Each page: `<body>` opaque background, `data-ready` set after `document.fonts.ready` and iframe `load`.

**Interfaces:** Consumes `panel.html?scene=…`, `SCENES`, `toMarkdown(state)` from `format.js`.

- [ ] **Step 1:** Build poster 1; render it (Task 3 command, or Chrome `--screenshot`) and look at it at full size and at 400 px wide (README phone width). Adjust until the headline reads at 400 px.
- [ ] **Step 2:** Build posters 2–4; render them side by side at 3 × 300 px and check the panorama joins line up and headlines read.
- [ ] **Step 3: Commit** `docs/posters/*.html docs/posters/poster.css` — "Posters: four README poster layouts".

### Task 3: Render script, PNGs, packaging

**Files:**
- Create/finish: `scripts/posters.sh` — `make_panel`, then for each poster:
  `Chrome --headless --allow-file-access-from-files --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=5000 --window-size=W,H --screenshot=docs/images/<name>.png file://…`;
  first checks each poster via `--dump-dom` and exits 1 if the title starts with `ERROR:`.
  Outputs: `docs/images/1-replay.png` (3200×1600), `2-prompt.png`, `3-test.png`, `4-share.png` (1800×2400 each).
- Modify: `scripts/package.sh:32` — add `docs/` to the exclude regex.

- [ ] **Step 1:** Run `bash scripts/posters.sh`. Expected: 4 PNGs, `sips -g pixelWidth -g pixelHeight` shows the sizes above.
- [ ] **Step 2:** Open each PNG and check: opaque, fonts are the intended ones, nothing cut off.
- [ ] **Step 3:** Run `bash scripts/package.sh` and `unzip -l dist/ActionRecorder-v*.zip | grep -c docs/`. Expected: `0`.
- [ ] **Step 4: Commit** `scripts/posters.sh scripts/package.sh docs/images/*.png` — "Posters: render script and PNGs".

### Task 4: README, version, release

**Files:**
- Modify: `README.md:1-3` — title, one-line pitch: "Record what you do in the browser once — replay it with new
  values, hand it to an AI agent as a prompt, or keep it as a UI test.", then
  `<img src="docs/images/1-replay.png" width="100%">`, then a 3-column `<p>` of `2-prompt`, `3-test`, `4-share`
  at `width="32%"` each, then a bold link to the Releases page.
- Modify: `manifest.json` version → `5.9.4`.
- Modify: `CHANGELOG.md` — `## 5.9.4 — 2026-11-24 (patch)` / `- Changed: the README on GitHub opens with four posters …` / `- No new permissions.`

- [ ] **Step 1:** Check the README renders on GitHub's layout locally: open README in a Markdown preview (or push and view) at desktop and 400 px width.
- [ ] **Step 2:** `bash scripts/package.sh` passes (CHANGELOG section found).
- [ ] **Step 3: Commit, tag, push:** "Release 5.9.4: README posters"; `git tag v5.9.4`; push main and tag.
- [ ] **Step 4:** `gh run watch` the Release run; `gh release list --limit 1` shows `v5.9.4 Latest`; view the README on github.com.
