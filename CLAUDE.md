# Action Recorder — working rules

## After every change: version, CHANGELOG, README
Each development (feature, fix or UI tweak) ends with these updates in the same commit:

1. **Version** — bump `version` in `manifest.json` per the *Versioning* section of `README.md`:
   MAJOR = breaking (export/flow format, removed feature, new permissions), MINOR = new feature, PATCH = fix or small UI tweak.
2. **CHANGELOG.md** — add a new section at the top, in the existing style:
   `## <version> — <YYYY-MM-DD> (major|minor|patch)` followed by `- Added:` / `- Changed:` / `- Fixed:` bullets
   that explain the change from the user's point of view (what they see / click, not internal code).
   Mention "No new permissions" when that is true. The release workflow uses this section as the release notes,
   so a version without a section cannot be released.
3. **README.md** — for a **new feature** (or a changed way of using one), update the matching section or add a new
   `## ...` section where it fits. Pure bug fixes usually need no README change.

## Releases
`scripts/package.sh` builds `dist/ActionRecorder-v<version>.zip`; pushing a tag `v<version>` (equal to `manifest.json`)
runs `.github/workflows/release.yml`, which publishes the GitHub release with the zip.
Never change or remove the `key` field in `manifest.json` (it pins the extension ID).
