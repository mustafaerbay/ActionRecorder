#!/usr/bin/env bash
# Builds the release zip and release notes for Action Recorder.
#   scripts/package.sh            -> uses the version in manifest.json
#   scripts/package.sh 5.9.0      -> fails unless manifest.json says 5.9.0 (used by the release workflow)
# Output: dist/ActionRecorder-v<version>.zip (manifest.json at the zip root) and dist/notes.md
set -euo pipefail
cd "$(dirname "$0")/.."

manifest_version=$(node -p "require('./manifest.json').version")
version=${1:-$manifest_version}
if [[ "$version" != "$manifest_version" ]]; then
  echo "Tag version $version does not match manifest.json version $manifest_version" >&2
  exit 1
fi

# Notes: this version's section of CHANGELOG.md (without its heading) + install steps.
section=$(awk -v v="$version" '
  $0 ~ "^## " v "([^0-9.]|$)" { on = 1; next }
  on && /^## / { exit }
  on { print }
' CHANGELOG.md)
if [[ -z "${section//[[:space:]]/}" ]]; then
  echo "No section for $version in CHANGELOG.md (expected a heading like: ## $version — ...)" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist
zip_name="ActionRecorder-v$version.zip"

# Every tracked file except repo-only ones (docs, CI, scripts, dotfiles).
git ls-files \
  | grep -vE '^(\.|README\.md$|CHANGELOG\.md$|scripts/|dist/)' \
  | grep -vE '(^|/)\.DS_Store$' \
  | zip -q -X "dist/$zip_name" -@

cat > dist/notes.md <<EOF
$section

## Install
1. Download **$zip_name** below and unzip it.
2. Open \`chrome://extensions\` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

To update, unzip the new version over the same folder and press ↻ on the extension card. Your saved flows are kept.
EOF

echo "Built dist/$zip_name"
unzip -l "dist/$zip_name"
