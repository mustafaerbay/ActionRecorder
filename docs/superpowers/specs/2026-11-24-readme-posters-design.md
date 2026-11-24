# README posters — design

## Why
The GitHub README is the first thing people see. It is plain text today, with no images. Goal: more people install
Action Recorder. Like the App Store example (700 → 5200 installs), it should be clear in a second, loud enough to
stop the scroll, and show the real product.

## Goals
- Four posters at the top of the README, each with one message:
  1. **Hero (orange):** "Record once. *Replay* with new values." Repetitive browser work goes faster.
  2. **Dark:** "Clicks → an *AI prompt*." The Markdown export an agent (e.g. Claude in Chrome) can follow.
     This is where the tool started.
  3. **Dark:** "Your UI test, *already written*." Checks, expected results, run report.
  4. **Orange:** "Group. *Share*. Import." Groups, .json export/import.
- Headlines of 2–4 words, with the key word big and italic. High contrast: orange first and last, dark in between.
- The app breaks out of the frame: the side panel is tilted, and steps, variables and checks pop out past the edges.
  Posters 2–4 connect into one panorama.
- Uses the **real side panel UI** (sidepanel.html + sidepanel.css with sample data), not invented screens.

## Non-goals
- Screenshot notes (PDF/Word), debug, loops and extraction are not on the posters. They stay in the README sections below.
- No change to the extension itself.

## Anti-goals
- Five same-looking pale cards, small text, or a phone sitting dead center.
- Posters that look like a different product from what people install.

## Approaches
- **A. HTML posters rendered to PNG with headless Chrome (chosen).** The real panel is rendered with sample data and
  placed in poster layouts. Full control over type and color, and it can be re-rendered when the UI changes.
- B. Hand-written SVG shown directly in the README: crisp, but GitHub limits fonts and embedded HTML, so no real UI.
- C. One animated GIF demo: shows the flow, but it is slow to read, heavy, and has no headlines.

## Layout in the README
- Below the title and one-line pitch: the hero poster full width (2:1).
- Under it: posters 2–4 side by side as one panorama strip (each 3:4 portrait), then the Install link.
- PNG files at 2× resolution in `docs/images/`. Poster sources in `docs/posters/`, rendered by `scripts/posters.sh`.

## Constraints
- English (the README is English).
- `scripts/package.sh` must exclude `docs/`, so the extension zip does not get bigger.
- Per CLAUDE.md: patch version, CHANGELOG section, README update; released like the other versions.

## Left to the builder
Exact sample data (flow names, steps, variables), fonts (Google Fonts are fine for rendering), the exact orange,
and the tilt/overlap details.
