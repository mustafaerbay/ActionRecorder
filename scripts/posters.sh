#!/usr/bin/env bash
# Renders the README posters (docs/posters/*.html) to docs/images/*.png with the local Google Chrome.
#   scripts/posters.sh          -> all posters
#   scripts/posters.sh panel    -> only (re)generate docs/posters/panel.html
# The posters embed the real side panel (sidepanel.html + its scripts) running on sample data (stub.js, scenes.js).
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
version=$(node -p "require('./manifest.json').version")
flags=(--headless --disable-gpu --allow-file-access-from-files --hide-scrollbars --no-first-run --no-default-browser-check)

make_panel() {
  # Same markup as the real panel; paths point back to the repo root; the chrome.* stub loads first.
  sed -E \
    -e 's#href="sidepanel\.css"#href="../../sidepanel.css"#' \
    -e 's#src="([a-z-]+\.js)"#src="../../\1"#' \
    -e "s#(<script src=\"\.\./\.\./format\.js\"></script>)#<script>window.POSTER_VERSION='$version'</script><script src=\"scenes.js\"></script><script src=\"stub.js\"></script>\1#" \
    sidepanel.html > docs/posters/panel.html
}

# Fails when the page reported an error (stub.js puts it in the title) or never got ready.
check_page() {
  local url=$1 dom
  dom=$("$CHROME" "${flags[@]}" --virtual-time-budget=5000 --dump-dom "$url" 2>/dev/null)
  if grep -q '<title>ERROR:' <<<"$dom"; then
    echo "Page error in $url: $(grep -o '<title>ERROR:[^<]*' <<<"$dom")" >&2; return 1
  fi
  if ! grep -q 'data-ready="1"' <<<"$dom"; then echo "Not ready: $url" >&2; return 1; fi
}

render() { # page output width height
  local url="file://$PWD/docs/posters/$1"
  check_page "$url"
  rm -f "docs/images/$2.png"
  "$CHROME" "${flags[@]}" --force-device-scale-factor=2 --virtual-time-budget=8000 \
    --window-size="$3,$4" --screenshot="$PWD/docs/images/$2.png" "$url" 2>/dev/null
  [[ -s "docs/images/$2.png" ]] || { echo "No image for $2" >&2; exit 1; }
  echo "Rendered docs/images/$2.png"
}

make_panel
[[ "${1:-}" == panel ]] && exit 0
mkdir -p docs/images
# Posters 2–4 are one panorama (strip.html) cut into three 900-px-wide parts.
render 1-replay.html 1-replay 1600 800
render 'strip.html?part=2' 2-prompt 900 1200
render 'strip.html?part=3' 3-test 900 1200
render 'strip.html?part=4' 4-share 900 1200
