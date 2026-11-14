# Changelog

## 5.9.1 — 2026-11-14 (patch)
- Added: a **☕ Buy me a coffee** link in the panel footer of every tab (next to the © line). It opens
  buymeacoffee.com/anatolman in a new tab.
- Changed: releases are published on the GitHub **Releases** page as `ActionRecorder-v<version>.zip`, with the
  install steps in the release notes.
- No new permissions.

## 5.9.0 — 2026-11-06 (minor)
- Added: **⤓ Markdown (.zip)** in the 📷 Screenshots tab — a .zip with `notes.md` and an `images/` folder
  (`screen-01.jpg`, … with the red numbered frames). The notes are a Markdown list per screen (`**[1]** note — _element_`),
  with headings, the page address and time. Unzip and keep them together: it renders in GitLab / GitHub, wikis,
  Obsidian, VS Code. Made inside the extension, no new permissions.

## 5.8.0 — 2026-11-06 (minor)
- Added: **⤓ Word (.docx)** in the 📷 Screenshots tab — a Word document with a title, then per screen a heading,
  the page address and time, the screenshot with its red numbered frames, and the notes as **editable text**
  (each with its red number). Headings show in Word's navigation pane; each screen starts on a new page.
  Made inside the extension like the PDF — nothing is uploaded, no new permissions.
- Changed: PDF and Word file names keep Turkish letters readable (e.g. `is-akisi-siparis-…`).

## 5.7.0 — 2026-11-06 (minor)
- Added: **📷 Screenshots** tab — screenshot notes exported as a PDF.
  - **▣ Mark an element:** click an element on the page (↑ / ↓ make the frame bigger / smaller, Esc cancels; the click
    is not passed to the page). A screenshot of the visible page is taken with a **red numbered frame** around the
    element, and a note box opens for it.
  - **+ mark** on a screenshot adds another numbered frame to that same screen (if the page was scrolled or changed
    in between, a new screenshot is taken instead). **📷 Whole screen** takes a screenshot without a mark.
  - Every screen has an optional note for the whole screen; screens can be reordered (↑ ↓) or removed.
  - **⤓ Export PDF:** a summary page (title, date, all notes per screen) + one page per screen with the frames,
    numbers and notes. Notes in any language (Turkish characters etc.) are kept, because the text is drawn into the
    pages. The PDF is made inside the extension — nothing is uploaded.
  - Screenshots and notes are kept in this browser profile until **Clear all**.
  - Elements inside iframes can be included with **Whole screen**, but cannot be marked one by one yet.
- No new permissions.

## 5.6.0 — 2026-11-06 (minor)
- Added: **🧪 Test step** (in **+ Add ▾**, while recording or editing) — a named test with an optional
  **expected result** and one or more **conditions that must all be true**: a variable value, a text on the page,
  the page URL. Nothing is clicked; at that point of the run the conditions are checked.
  - **If it fails:** *mark FAIL and continue* (default) or *stop the run* (Retry / Skip / Stop).
  - The run report starts with a **Test steps** table: name, expected result, ✓ PASS / ✗ FAIL and what was seen for
    each condition (test steps that did not run are listed as NOT RUN). The replay message shows
    "test steps: 3 passed, 1 failed"; any failed test step makes the run FAILED.
  - **After the run** requests can use `{{TEST_RESULTS}}` ("3 of 4 passed — failed: TC-03 …") and `{{TEST_TABLE}}`.
  - The Markdown export tells the agent to report a Test steps table; group chain reports show 🧪 passed/total.
- Changed: in a condition, switching between variable / page text / URL resets the comparison to its usual one
  (variable → "is", page text / URL → "shows" / "contains").

## 5.5.0 — 2026-11-06 (minor)
- Added: **⤵ while recording** — choose where the next recorded steps go without stopping the recording. Press ⤵ on
  an If / Else if / Else row to record into that case (e.g. after pressing End if too early), or on any step to record
  after it. A blue bar shows the place (e.g. `⤵ Recording after step 4, inside "If {{ENV}} is "prod""`) with
  **Back to the end**; the row is underlined.
- Added: the If row's **✎ condition**, **+ Else if**, **+ Else** and **×** now also work while recording.
- Fixed: after **Back to the end**, the next step only waits for the time since then (no long recorded wait for the
  time spent recording elsewhere). Page-change de-duplication looks at the steps at the insertion point.
- Fixed: removing an If block (or a case) while it was still open keeps the If bar right.

## 5.4.0 — 2026-11-05 (minor)
- Added: **↩ from here** — while a replay waits (a failed step, a step for you to do, or a debug pause), the earlier
  steps get a **↩ from here** button. Press it to run again from that step: it and every step after it run again
  (variables keep their values; If blocks are decided again). Useful when a later step failed because something
  earlier did not take effect — e.g. after fixing the page by hand or after a session expired.
  - Not offered for steps inside a "For each item" loop (go back to the ⟳ loop step itself) or on Else if / Else /
    End if rows. The run report shows the result of the last attempt.

## 5.3.1 — 2026-11-05 (patch)
- Fixed: clicks on different items of a **tree / list that handles the clicks itself** (e.g. a
  `traceNaveTree___treeContainer` with `tabindex="0"`) were all recorded as the same container element, so the replay
  could not click the right item. The recorder now records the **item you clicked** (step shows `item "Order service"`).
- Fixed: at replay such an item is found **by its text** when the list order changed; if several items have the same
  text it stops instead of guessing.
- Flows recorded before 5.3.1 keep the old container step — re-record those clicks (Flow check shows them as
  "… all click the same unnamed element").

## 5.3.0 — 2026-11-04 (minor)
- Added: **If a step fails:** on the flow card — *ask me (Retry / Skip / Stop)* (as before) or **stop the run and
  report**. With the second, the run ends at the first failing step as FAILED, and the report, the notification and
  the **After the run** requests go out without anybody having to answer. Use it for runs nobody watches.
- Fixed: a step failed but the **After the run** request was not sent — the replay was still waiting at the failure
  for Retry / Skip / Stop, and the requests only go out when the run ends. The failure message now says so when the
  flow has After-the-run requests.
- Fixed: pressing **■ Stop** at a failed step now gives `{{RUN_RESULT}}` = **FAILED** (it was STOPPED) and the message
  "Replay stopped — step N failed". In a group chain, Stop still stops the whole chain.
- Fixed: an unexpected error during a replay now ends the run as FAILED with its report and After-the-run requests,
  instead of leaving it hanging.

## 5.2.0 — 2026-11-04 (minor)
- Added: **After the run** — requests a flow sends once it has ended, e.g. to notify a chat group with the result.
  On the flow card press **After the run** → **+ HTTP request**, choose when: **always**, **only if the run PASSED**
  or **only if it FAILED or was STOPPED**, and set it up like a 🌐 Request step.
  - They are sent also when a step failed or you pressed ■ Stop (a request as the last *step* would not be reached).
  - They can use the run's result: `{{FLOW_NAME}}`, `{{FLOW_VERSION}}`, `{{RUN_RESULT}}` (PASSED / FAILED /
    STOPPED), `{{RUN_SUMMARY}}`, `{{FAILED_STEPS}}`, `{{DURATION}}`, `{{STARTED_AT}}`, `{{FINISHED_AT}}`, `{{ENV}}`,
    `{{RUN_REPORT}}` (the whole report) — offered in *Insert variable ▾* — plus the flow's own variables (asked in the
    run form like the others, 🔒 values masked).
  - A failing request does not change the run's result; the replay message, the run report ("After the run" table)
    and the Markdown export show them. They work in debug runs and group chains (per flow), and are kept by Update
    flow, Save as new, .json and Export all.

## 5.1.0 — 2026-11-04 (minor)
- Added: **🔑 saved passwords / secret values** — a 🔒 value no longer has to be typed at every run:
  - In the run form, **Remember the 🔒 values I type, on this computer** (on by default): type the password once;
    from then on it is filled in automatically (hidden) — shown as "🔑 saved on this computer", with **forget**.
  - In **Environments**, a 🔒 variable can get its value directly ("type to save on this computer") — so DEV, TEST
    and PROD can each have their own password.
  - Saved values are **encrypted** (AES-GCM; the key is generated once and cannot be read out of the browser) and
    kept only in this Chrome profile on this computer. They are never part of a flow, an export (.json, Export all,
    environment export, Markdown) or a run report. Anyone using this computer account and Chrome profile can still
    run flows with them — like passwords saved in the browser.
- Changed: typing into a **password field while recording** now gives the step a 🔒 variable automatically
  (`{{PASSWORD}}`; e.g. `{{NEW_PASSWORD}}` for a "New password" field, and a "Confirm password" field reuses the one
  before it). Older flows get it when opened with **Edit** (then Update flow).
- Changed: Export all and the environment export never contain the value of a variable that is used in a password
  field, even if it was not marked 🔒.
- Fixed: the "If a flow fails" option of group chains was also shown in the run form of a single flow.

## 5.0.0 — 2026-11-03 (major — Markdown export format)
Fewer agent mistakes, based on a real export and a real agent error (an "Increase by 0.5" step was done as
"set to 0.5", because the field was named after its recorded value "0").
- **Export rewritten for agents** (.md / Copy):
  - Short header (name, version, start URL, number of actions); the flow description as a quote.
  - **Before you start**: get every variable (ask for the missing / 🔒 ones, never guess), check the values are
    allowed, open the start URL, and — for flows that Increase / Decrease / Append — run the flow only once and
    check a field before repeating a step.
  - **Variables** table with value, ✱ required, and the **allowed values** taken from the If conditions.
  - **Flow outline**: the If blocks and loops as short pseudo-code with step numbers.
  - **How to do the steps**: only the rules this flow needs (exact comparison rule for If blocks, decide once,
    Type replaces the field, Choose / Tick are not checks, …).
  - **Steps**: only actions are numbered; If / Else if / Else / End if are labelled blocks ([B1], [B2] …).
  - **Increase / Decrease** say exactly what to do: read the number the field shows *now* → calculate → clear →
    type → check; never use a number from the file as the current value.
  - Radios: "Choose radio option …"; checkboxes: "Tick / Untick …" (no more "Check", which also meant a
    verification). The first step is "Open … (start here)".
  - **When you are done**: report which case each block took and why, every changed field before → after (with the
    calculation), checks, failed / skipped steps, and whether the final action ran — never secrets.
- **Better element descriptions when recording** (new recordings): fields in tables get their **row and column
  names** ("field in row "Nurhak Sozer", column "Development""); a placeholder or name that is only a number is no
  longer used as a label; radios / checkboxes get a stable selector by group and value; fields by name, placeholder,
  aria-label. Replay falls back to these and to the table row / column when the page changed.
  Older recordings without names are described by their table position (row 3, column 5) instead of "0".
- **⚠ Flow check** on each flow card and in the editor: the same selector for different elements, elements without a
  usable name, If blocks without Else, steps added without clicking, passwords typed without a variable, passwords
  kept in plain text in an environment, variables nobody provides. In the editor a click on a finding shows the step.
- **Security:** a variable typed into a password field is always 🔒 secret — its value is never stored or exported and
  it is asked at every run (or taken, hidden, from an environment). Values already stored by older versions are
  removed when the panel opens.
- The editor numbers only actions (like the export and the flow check).
- Checked by letting a separate agent follow the new export of a real flow (it did the Increase correctly: read 0.5 →
  typed 1). From its feedback: "every run adds again" is stated as intended (only a *retried* step must be checked
  first); "don't click again if the page is already in that state" (menus, tabs); and the flow check suggests a
  ✓ Check after a final click that nothing verifies.

## 4.1.0 — 2026-11-03 (minor)
- Changed: the tools that add steps — **⑂ If**, **✓ Check text**, **⤓ Capture value**, **⏸ Approval**,
  **🌐 Request**, **🖱 Add click**, **⟳ For each item** — are now in one **+ Add ▾** menu at the top, so the header
  is a single row: *+ Add ▾ · ❚❚ Pause · ■ Stop* while recording, *+ Add ▾ · ● New · ▶ Continue · 💾 Save* when
  stopped. The menu lists only the tools that apply (recording, paused, or editing).
  - Keyboard: ↑ ↓ to move, Enter to choose, Esc to close; a click elsewhere also closes it.
  - While a click is being picked with 🖱 Add click, the button reads **✕ Cancel click**.

## 4.0.1 — 2026-11-03 (patch)
- Fixed: while a recording was **paused** only Resume / Stop were shown, so an If block (or a check, request,
  approval, click or capture) could not be added without stopping. They are now available while paused too, together
  with Else if… / Else / End if.
- Fixed: rows and steps added during a pause (and notes) are placed before the pause, so the first step after Resume
  no longer shows the pause as a long "wait".

## 4.0.0 — 2026-11-03 (major — flow format)
- Changed: **⑂ If / Else if / Else are now rows in the step list** — a block is `⑂ If <condition>`, the steps of that
  case (indented), optional `⑂ Else if <condition>` / `⑂ Else` cases with their steps, and `⑂ End if`. You see and
  manage the structure directly instead of conditions hidden on each step.
  - Recording: **⑂ If** adds the If row; **Else if…**, **Else** and **End if** add the other rows (■ Stop closes an
    open block).
  - Editing: **⑂ If** adds an empty block at the ⤵ point (or at the end) — new steps then go into it. Each row has
    its tools: **✎** change the condition, **+ Else if**, **+ Else**, **⤵** insert steps into that case (on End if:
    after the block), **×** remove (If: the rows go, the steps stay and then always run; Else if / Else: that case
    and its steps, after a confirmation). **↑ ↓** on a step moves it into or out of a case.
  - Replay decides the block once at the If row (variable, page text or page URL), runs the first true case (or Else)
    and marks the rest "– not needed". The replay view is indented the same way; blocks also work inside loops
    (decided per item), and in debug mode, chains and run reports.
  - The step counts (card, summary, report) do not count the ⑂ rows.
  - Markdown export: the rows are listed as **If / Else if / Else / End if** with the case steps marked "›", and the
    agent is told to decide the block once and do only the steps of that case.
- Changed: flows saved with 3.6–3.10 (a condition on each step) still replay as before; when opened with **Edit** they
  are turned into If / Else if / Else rows automatically (saved as such with Update flow).
- Removed: the ⑂ button on every step (it remains only on steps that still carry an old condition).
- **Compatibility:** flows that contain the new rows cannot be replayed by Action Recorder 3.x — update everyone who
  shares flows to 4.0.0.

## 3.10.0 — 2026-11-03 (minor)
- Added: **Optional steps**. In ✎ of a step that uses an element (click, double-click, type, set, select,
  checkbox, key, capture) tick **Optional — skip this step if the element does not appear within N s** (default 3 s).
  For things that are only sometimes there: a cookie banner, a "What's new" popup, a Close or Continue button.
  - If the element is missing — or in the page but hidden — the step is skipped ("– not on the page"), not failed,
    and the replay continues without asking Retry / Skip. Only the short optional wait is spent, not the full
    element wait.
  - The "Page opens" / "URL changes" steps recorded right after a skipped click are skipped as well (that page
    change will not happen).
  - Works inside loops; an optional ⤓ capture leaves its variable unset. Marked "optional (N s)" on the step;
    the Markdown export tells the agent to skip it when the element is not there.

## 3.9.0 — 2026-11-03 (minor)
- Added: **🌐 HTTP request step** (GET / POST / PUT / PATCH / DELETE) — press **🌐 Request** while recording, or while
  editing (at the ⤵ point or at the end); change it later with ✎.
  - URL, headers (one per line, e.g. `Authorization: Bearer {{TOKEN}}`) and body (JSON, form fields or text) can use
    variables. In a JSON body variable values are escaped, so quotes or new lines cannot break the JSON.
  - **Send from the extension** (any URL, not limited by the browser's cross-site rules; authentication only via
    headers/body — e.g. a token) or **from the current page** (same site as the tab, with your login cookies).
  - **Expected status** (default 2xx; e.g. `200`, `200, 201`, `4xx`, `any`): otherwise the step fails and shows the
    status and the response text — Retry / Skip / Stop as usual.
  - **Save from the response**: `data.id → ORDER_ID`, `data.items[0].name → NAME`, `@status → STATUS`,
    `@text → RESPONSE` — usable in later steps and in conditions.
  - Replay view and run report show method, URL, status and time; 🔒 secret values are masked. The Markdown
    export tells the agent to send the same request (with the body).
- Added: **If / Else if / Else**. While recording: **⑂ If** → steps → **Else if…** (another condition) → steps →
  **Else** → steps → **End if**. While editing: in ⑂ on a step choose *If*, *Else if* or *Else* (of the block
  above). The first case that is true runs; Else runs only when no case above ran.
- Changed: **Else** recorded from now on means "none of the cases above" (flows saved with 3.6/3.7 keep working).

## 3.8.0 — 2026-11-03 (minor)
- Added: **Increase / Decrease / Append** for "Type" and "Set" steps. In the step editor (✎) choose *What to do*:
  replace the value (as before), **add to the number in the field**, **subtract from the number in the field**, or
  **append to the text in the field**. The amount can be a number or a variable (e.g. `{{STEP}}`).
  - The current value of the field is read on replay: e.g. 5 + `{{STEP}}`=3 → 8. Numbers like `1234.5`,
    `1,234.50` and `1.234,50` are understood and the result keeps the field's style (e.g. 9.999,99 + 0,01 →
    10.000,00). An empty field counts as 0; a field without a number fails the step with a clear message.
  - **Save the new value as variable** (optional) keeps the result, e.g. `{{NEW_QTY}}`, for later steps — it is
    offered in *Insert variable ▾* and in conditions, and not asked in the run form.
  - The replay view / run report show the calculation (e.g. "5 + 3 = 8 · {{NEW_QTY}} = 8"); the Markdown export
    tells the agent ("Increase the number in field … by {{STEP}} (new value = current value + {{STEP}})").

## 3.7.0 — 2026-11-03 (minor)
- Added: **⑂ conditions on the page** — besides a variable, a condition can look at the **page text** (*shows* /
  *does not show* "Sign in") or the **page URL** (*contains* / *does not contain* / *matches regex* "/login").
  Typical use: log in again only when the session has expired — the login steps run only if the page shows "Sign in"
  (or the URL contains /login), otherwise they are skipped and the flow continues.
  - The page is checked after it has settled (loaded, no requests in flight), and the text may appear a moment later.
- Changed: steps that share the same condition form a **block that is decided once, at its first step** — so a login
  block keeps running after "Sign in" disappears. An **Else** block recorded with Else is the opposite of its If block
  (not checked again). Retrying a failed step inside a block keeps the decision.
- The Markdown export tells the agent to decide such a block once.
- Fixed: when a page did not answer a request from the side panel at all, the replay could wait forever instead of
  giving up after the timeout.

## 3.6.0 — 2026-11-03 (minor)
- Added: **⑂ conditions ("only if")** — a step runs only when a variable matches, e.g. *only if `{{TYPE}}` is "company"*;
  otherwise it is skipped on replay and marked "– not needed". Operators: is, is not, contains, does not contain,
  is empty, is not empty, matches regex, does not match regex (trimmed, not case-sensitive; the value may itself use
  `{{VARIABLES}}`). Works with environment / flow / run-form variables, values asked (⏸) or captured (⤓) earlier,
  and `{{item}}` / `{{index}}` inside loops.
  - While recording: **⑂ If** → the steps you record next get the condition; **Else** switches to the opposite case;
    **End if** ends it. So both branches can be recorded in one go.
  - While editing: **⑂** on a step sets, changes or removes its condition, optionally *also for the next N steps*.
  - A condition on a "For each item" step skips the whole loop.
  - Condition variables are asked in the run form like other variables; the run report and the replay view say why a
    step was not needed; the Markdown export tells the agent ("⑂ Only if … — otherwise skip this step").
- Fixed: clicking on an empty part of the page (e.g. to leave a field) was recorded as a "Click html …" step without a
  selector that could not be replayed. Such clicks are no longer recorded.
- Changed: the recording buttons wrap to a second line instead of breaking their labels.

## 3.5.1 — 2026-11-02 (patch)
- Changed: a green **💾 Save** button now appears next to **▶ Continue** at the top as soon as a recording is stopped
  (**💾 Update flow** while editing a saved flow), so it is easy to find. The Save button at the bottom still works.

## 3.5.0 — 2026-11-02 (minor)
- Added: **wait for the page to be ready before every step**. Besides waiting for the element to appear, the replay
  now also waits until
  - the element is **enabled** (a button that is disabled until data has loaded is no longer "clicked" too early and
    marked ✓ — if it stays disabled, the step fails with a clear message),
  - no **loading overlay / spinner layer** covers it,
  - the page has **settled**: finished loading, no requests (fetch / XHR) in flight and no changes for a moment.
  The settle wait is capped at a few seconds per step, so pages that never get fully quiet (clocks, animations) are
  not slowed down much. ⤓ Capture value also lets the page settle first.
- Added: **⏱ Wait for elements up to** 15 s (default) / 30 s / 1 min / 2 min / 5 min on each saved flow, for slow systems.
  Used by replays, debug runs and chains; the Markdown export tells the agent to wait as long.

## 3.4.0 — 2026-11-02 (minor)
- Added: **run a group as a chain** — **▶ Run** in a group header runs all its flows one after another in the group's
  order. One run form for the whole chain: every variable the flows need (merged; ✱ required and 🔒 secret if any flow
  says so), one environment, and *If a flow fails: stop the chain / continue with the next flow*.
- Values asked (⏸) or captured (⤓) in one flow are available to the following flows.
- The replay view shows the chain's progress (✓ / ✗ / ▶ per flow); **■ Stop** also works between two flows.
- **Download chain report**: a summary table (result, steps, checks, duration per flow, flows not run) followed by
  each flow's full run report. Extracted data of all flows can be downloaded at the end.
- One notification when the chain ends (questions during the flows are still notified).
- A flow counts as failed when a step failed, a check failed, a loop item failed, it was rejected or stopped.
- Fixed: the run report's "Finished" time / duration could be empty when the report was created right at the end.

## 3.3.0 — 2026-11-02 (minor)
- Added: **flow groups**. Put related flows in a group with the 📁 menu on a flow card (or **+ Group** above the list).
  Groups are sections you can collapse (▸/▾), reorder (↑ ↓), rename (✎) or delete (×) — deleting a group keeps its
  flows, without a group. Flows without a group are listed first under "Not grouped".
- Added: **ordering** — ↑ ↓ on a flow card moves it within its group; the order is kept.
- Added: **search** above the list (name, description or group); matching flows are shown even in collapsed groups.
- Save as new keeps the group; .json, Export all and Import carry groups and their order.

## 3.2.0 — 2026-11-02 (minor)
- Added: **flow descriptions**. Press **Description** on a saved flow to write what the flow does, when to run it, what
  must be ready first and the expected result (multi-line, Ctrl+Enter saves). It is shown under the flow name (long
  texts are shortened — click to expand), at the top of the Markdown export ("About this flow", so the agent knows the
  purpose) and of the run report. Like the name it is not versioned: Update flow keeps it, Save as new copies it, and
  .json / Export all / Import carry it.

## 3.1.1 — 2026-10-22 (patch)
- Fixed: when a page could not be opened at all (server down, unknown address, certificate error, no network) the
  "Start on" / "Go to" step was still marked ✓ and the replay then got stuck on the next step. The step now fails right
  away with the reason, e.g. "Page could not be opened: the server refused the connection — is it running on that port?
  (ERR_CONNECTION_REFUSED)", and you can **Retry** (the page is loaded again), **Skip** or **Stop**. The reason also
  appears in the run report; inside loops the item is marked failed.

## 3.1.0 — 2026-10-22 (minor)
- Added: **Required variables**. In *Variables of this flow* tick **Required** next to a variable; the flow then cannot be
  replayed (or debugged) until that variable has a value — from the chosen environment, the flow default or typed in the
  run form. **Run** stays blocked and names the missing variables instead of offering "run anyway".
- The variables list now also shows variables the steps use without a flow default (e.g. `{{BASE_URL}}` that only comes
  from an environment), so they can be marked Required or given a default.
- Required variables are marked ✱ on the flow card, in the run form and in the Markdown export ("do not start the flow
  until it has a value").

## 3.0.1 — 2026-10-22 (patch)
- Fixed: inserting steps into a saved flow (⤵ + Record here, or adding a check / approval / click at an insertion point)
  showed a huge wait such as "⏳ wait 70m 50s" — the time between the original recording and the edit was counted as a
  wait. Inserted steps now only wait for the real time between them while recording, steps added without recording get
  no wait, and the step after the insertion point keeps its original wait. Moving steps (↑ ↓) keeps their waits too.
- Fixed: the step times (+mm:ss) and the timer of a flow being edited no longer jump by the time since it was recorded.
- Added: **×** on a wait row removes that wait (for flows saved with an older version that still show a long one).
  Waits of a minute or more are shown as "idle … — not waited on replay".

## 3.0.0 — 2026-10-22 (major — new permission)
- Added: **desktop notifications for replays**. You get one when a replay needs you — ⏸ approval, a value to type, a manual
  step (password, file upload, note), a failed step waiting for Retry / Skip / Stop, or a debug breakpoint — and when it
  finishes or stops (with the number of failed checks). Questions stay on screen until you react; clicking a notification
  brings the replay's tab and window to the front. Nothing is shown while you are looking at the side panel.
- Added: **🔔 Notify** switch in *Saved flows* (on by default).
- New permission: `notifications` ("Display notifications"). Chrome asks to accept it when updating from 2.x; saved
  flows, environments and exports are unchanged and fully compatible.

## 2.12.0 — 2026-10-22 (minor)
- Added: **Export all** in *Saved flows* — downloads `action-recorder-flows-<date>.json` with every saved flow (including
  its versions and history) and the shared environments. Secret (🔒) values are never included.
- Improved: **Import .json** also restores an Export-all backup: flows you already have (same or newer version) are skipped,
  new environments are added and missing variables are added to existing ones (existing values are never overwritten).
- Changed: buttons are smaller and more compact across the panel.

## 2.11.0 — 2026-10-22 (minor)
- Added: **🖱 Add click** — record a click on a button **without clicking it** (e.g. Delete, Submit, Send). Point at the
  element (it is outlined), click: the click is blocked, the page does not react, and a *Click* step marked
  "added without clicking" is added. On replay the element is clicked normally. Works while recording and while editing a
  flow (together with ⤵ to place it anywhere), and inside loops (current item).
- Fixed: text typed right before using a picker (Add click, Capture value, Check area, Pick field) could be lost.
- Improved: the picker's instruction banner moves to the bottom when the element you point at is near the top of the page.

## 2.10.0 — 2026-10-22 (minor)
- Added: **Insert variable ▾** in the step editor (✎) for typed text, options, URLs, notes, popup answers and check
  keywords. It lists every variable the flow knows — asked during the run, captured from the page, flow variables,
  environment variables and `{{item}}` / `{{index}}` in loops — and inserts `{{NAME}}` at the cursor.
- Added: ⏸ **Ask for a value … and type it into a field**. In the Approval form tick the option and **Pick field**;
  on replay the answer is typed into that field (also inside loops, in the current item) — no separate typing step needed.
  The option can be removed later in the step editor. Debug mode highlights the field.

## 2.9.1 — 2026-10-22 (patch)
- Fixed: a "Go to" step whose URL comes from a variable with a value that is not a web address (e.g. `asd`) opened a broken
  page and was marked ✓. Now the step fails with a clear message ("… is not a web address — check the value of {{OTP}}").
  Values like `wiki.example.com/page` get `https://` added; `localhost:8765/…` and IP addresses get `http://`.
- Changed: **Download run report** is available after every run (before: only when the run had checks or loops).
  The report now lists every step with its result and note, the overall result (passed / failed / stopped / rejected),
  the mode (Replay / Debug), and the real start, finish and duration (before: the download time).
  File name includes the flow version and run time, e.g. `my-flow-v2-run-20261022-1604.md`.

## 2.9.0 — 2026-10-22 (minor)
- Added: **insert steps anywhere**. In a stopped recording / while editing a flow, **⤵** on a step sets the insertion point
  (a red marker shows "new steps go here"); **▶ Record here** records new steps at that point, in order, and the following
  steps move down. Checks, captures, approvals and loops added there are inserted at that point too.
  ⤵ again (or *cancel* on the marker) goes back to adding at the end.
- The "Continue on <page>" step is only added when you are on a different page than the flow is at the insertion point.

## 2.8.0 — 2026-10-22 (minor)
- Added: **⤓ Capture value** while recording — click an element and read its visible text, a field value or an attribute
  (e.g. `href`), optionally keep only part of it with a regex (e.g. `#(\d+)` → the order number), and save it as a variable
  such as `{{ORDER_ID}}` for the following steps (typed text, URLs, checks …). Live preview of the value in the form.
- On replay the value is read fresh from the page every run (waits up to 15 s for it to appear); inside a
  "For each item" loop it is read from the current item. Captured values appear in the step notes and the check report.
- A Check text that uses a captured variable is tested with the captured value while recording ("passes now").
- Capture steps can be edited (✎): what to read, attribute, regex, variable name. Debug mode highlights the element.

## 2.7.0 — 2026-10-22 (minor)
- Added: **flow versions**. Each saved flow shows its version (v1, v2 …), last-updated and created dates and the latest
  change note. **Update flow** saves a new version and asks "What changed?" (optional); with no changes no version is made.
- Added: **History** per flow (last 20 versions) with date and note; **Restore** an older version (saved as a new version,
  nothing is lost) or export it as **.json**.
- The flow version and dates appear in the editing banner, the replay title, the Markdown export and the check report;
  export file names include the version (e.g. `my-flow-v3.json`). Imported flows keep their version and history.
- Renaming, breakpoints and per-flow settings do not create a version. Existing flows start as v1.

## 2.6.0 — 2026-10-22 (minor)
- Added: **variables** — use `{{NAME}}` in typed text, URLs (incl. the start page), dropdown options, keys, notes,
  check keywords and popup answers. Built-in in loops: `{{item}}` (current item name) and `{{index}}`.
- Added: **→ Make variable** in the step editor turns a recorded value into `{{NAME}}` and keeps the recorded value as the
  flow's default (for URLs the site part, e.g. `{{BASE_URL}}/merge_requests`). "Variables of this flow" box to manage them.
- Added: **Environments** (Saved flows → Environments): shared variable sets such as DEV / TEST / PROD for all flows,
  with export / import (.json, without secrets).
- Added: **run form** before Replay / Debug when a flow uses variables: choose the environment and check or change the
  values for this run. Missing values are highlighted.
- Added: **🔒 secret variables** (e.g. `{{PASSWORD}}`): never stored, typed in a masked field at every run, shown as ••••
  in reports. Password steps can now use a secret variable instead of pausing.
- Added: **⏸ Approval steps** (while recording or editing a flow): *Wait for approval* (Approve / Reject — reject stops the
  run) or *Ask for a value* (stored as a variable, e.g. `{{OTP}}`, for later steps).
- Markdown export lists the variables and explains ⏸ steps to the agent; the check report shows the environment and values
  (secrets masked). Flow JSON exports include variables without secret values.
- Fixed: in the environment / variable editors a new row did not appear until clicking elsewhere.

## 2.5.0 — 2026-10-22 (minor)
- Added: **🐞 Debug** mode for saved flows. The run pauses before step 1 and before every step after **Step ▸**;
  **Continue ⏩** runs to the next breakpoint, **Skip** skips the next step, **Stop** ends the run.
- Added: **breakpoints** — in debug mode click a step number to set/remove ● (pause before that step). Breakpoints are saved
  with the flow and work inside loops (pause for every item). Normal ▶ Replay ignores them.
- Added: while paused, the element the next step will use (or the check area / the list) is outlined on the page, and the
  panel says whether it was found and what it is on the current item.
- Fixed: pause/failure buttons now disappear as soon as one is pressed (a quick second click was ignored).

## 2.4.0 — 2026-10-22 (minor)
- Added: **Edit** saved flows. *Saved flows → Edit* opens the flow in the Recording tab (banner shows which flow).
  - ✎ change a step in place: typed text, dropdown option, URL, key, note, checkbox state, popup answers,
    check keywords / must (not) exist / match / match case, loop limits and on-failure, extraction page limit.
  - ↑ / ↓ move steps (also into or out of a loop), × remove steps; ▶ Continue records more steps at the end.
  - **Update flow** saves the changes over the original; **Save as new** keeps the original and saves a copy.
- Editing a check clears its "passes/fails now" result (it no longer applies).

## 2.3.3 — 2026-10-22 (patch)
- Added: copyright header in every source file (.js, .css, .html) and a proprietary `LICENSE` file.
- No functional changes.

## 2.3.2 — 2026-10-22 (patch)
- Added: "© Mustafa Erbay. All rights reserved." next to the version in the side panel footer (all tabs), and the
  author in the extension details.

## 2.3.1 — 2026-10-22 (patch)
- Fixed: **"must NOT exist" checks could pass too early** on pages that load content after the page appears
  (single-page apps such as CodeHub merge requests): the check ran while the area was still empty.
  Now such a check decides only when the area's text has stopped changing (2 s, at least 3 s after the step starts) and,
  for checks recorded with 2.3.1+, when the area has at least ~40% of the text it had when recorded.
  If it never settles, the result says "⚠ content looked incomplete" / "content was still changing".
- Check results for "must NOT exist" now show how much text was checked, e.g. "none found (checked 1,234 characters)".
- Checks wait up to 12 s (was 8 s).

## 2.3.0 — 2026-10-22 (minor)
- Added: the loop bar shows the detected pagination and has **Pick Next button** (for Next buttons that are not detected
  automatically, e.g. icon-only arrows), **No pagination**, and **Max pages** (default 20).
- Changed: "Include next pages" checkbox replaced by the options above.
- Fixed: the agent export says "(icon, no text)" instead of "?" for Next buttons without text.

## 2.2.1 — 2026-10-21 (patch)
- Improved: loop reports now show, for every item, the item's details from the list, what was actually clicked
  (e.g. *Click link "Order 1003"*), which page it opened (title + URL, or "same page" for popups), one column per check
  with what was found, the overall result, real errors (element not found, …) and the time per item.
  Same columns in **Download item results (.csv)**.

## 2.2.0 — 2026-10-21 (minor)
- Added: **⟳ For each item** loops while recording. Pick the list with the visual picker, record the steps for one item
  (open it, add checks, go back), then press **End loop**. Options: include next pages, max items, on failure
  *next item* (default) or *stop*.
- Added: clicks inside a list item are recorded relative to the item, so replay uses the same element of every item.
- Added: replay runs the loop for every item — returns to the list after each item (browser Back, reopening the page, or
  paging forward again for JavaScript pagination), closes tabs the item opened, and continues on the next pages.
  Works with detail pages, popups/modals and links that open new tabs.
- Added: per-item results — loop summary in the replay bar, **Download item results (.csv)** and the check report
  (one row per item plus every check).
- Added: the Markdown export marks loop steps with ↻ and tells the agent to repeat them for every item.
- No new permissions; existing flows keep working.

## 2.1.0 — 2026-10-21 (minor)
- Added: **✓ Check text** while recording — verify keywords on the page. Prefilled from the text you select on the page;
  one keyword per line; *must exist* / *must NOT exist*; *contains* / *whole word* / *regex*; *Match case*.
- Added: **Pick area** to check only one part of the page (visual picker; ↑ / ↓ to grow / shrink the area).
- Added: the check is evaluated when you add it ("passes now" / "fails now") and stored as a step; the Markdown export tells
  the agent to report PASS / FAIL.
- Added: replay runs checks (waiting up to 8 s for late-loading text) and shows ✓ PASS / ✗ FAIL with what was found.
  Per flow: *If a check fails → stop the replay* (default) or *continue and report*. Summary at the end and a
  **Download check report** (Markdown).
- No new permissions; existing flows keep working.

## 2.0.0 — 2026-10-21 (major)
- Changed: the extension ID is now pinned with a fixed `key` in `manifest.json`. The ID is always
  `jdeoehbmlhkofaijeglffhcnamimmnen`, whichever folder the extension is loaded from, so future updates keep saved flows.
- **Breaking (one time):** the ID differs from 1.x, so flows saved in the browser by 1.x are not visible in 2.0.0.
  Before upgrading, export each saved flow as **.json** in 1.x, then use **Import .json** in 2.0.0.
- No other changes; no new permissions.

## 1.4.0 — 2026-10-21 (minor)
- Added: **Extract list** tab. *Pick list item* turns on a visual picker in the page: while hovering, every item of the
  repeating list is outlined and numbered; click one item to select the list.
- Added: automatic columns (text fields by structure, table headers for `<table>` rows, plus link and image URL).
- Added: automatic Next / "Load more" button detection (rel=next, Next/›/»/Sonraki/İleri/Daha fazla…), highlighted in
  orange; *Pick Next button* to choose it yourself, or *No pagination*.
- Added: **Extract all pages** — walks the pages (link navigation, JS paging and load-more), removes duplicates, stops when
  Next is missing/disabled, the list stops changing, or the max-pages limit is hit. Download CSV / JSON or copy as Markdown.
- Added: when recording, the extraction is saved as one "Extract all items" step (its own page clicks are not recorded).
  The Markdown export tells the agent how to paginate and includes the data under "Extracted data" (first 200 rows).
- Added: replaying a flow re-runs its extractions with live data; download the data from the replay bar when it finishes.

## 1.3.0 — 2026-10-21 (minor)
- Added: **Save** a stopped recording as a named flow; new **Saved flows** tab with Replay, export (.md / .json),
  Rename and Delete.
- Added: **Import .json** — load a flow exported from this extension (also accepts the older recording .json export).
- Added: **Replay** inside the browser. Opens the start URL in a new tab and repeats each step, waiting up to 15 s for
  elements and modals to appear. Recorded alert/confirm/prompt answers are given automatically.
- Added: replay pauses for steps a script must not or cannot do — passwords, file uploads, and your notes — and continues
  when you press **Continue**. On a failed step you can **Retry**, **Skip** or **Stop**.
- Added: option "Replay with recorded waits" to keep the recorded pauses instead of only waiting for elements.
- No new permissions; existing recordings and exports keep working.

## 1.2.0 — 2026-10-21 (minor)
- Added: actions inside modals/popups are tagged with their dialog (`<dialog>`, `role="dialog"`, `aria-modal`, Bootstrap,
  MUI, Ant Design, Element, Vuetify, SweetAlert2, Angular Material, PrimeNG, Chakra, react-modal). The export tells the
  agent to wait for the dialog before acting in it.
- Added: native browser `alert` / `confirm` / `prompt` popups are recorded with the message and your answer
  (OK / Cancel / typed text), via a new page-world script `page-hooks.js`.
- Added: elements inside web components (open shadow DOM) are recorded, including dropdown/checkbox changes;
  the export names the shadow host.

## 1.1.0 — 2026-10-21 (minor)
- Added: Pause / Resume while recording. Paused time is not recorded and never becomes a "wait" step.
- Added: Continue after Stop, which appends to the same recording and adds a "Continue on <url>" step when the page changed.
- Added: version shown in the side panel footer.
- Changed: timer, step offsets and export duration count active time only.

## 1.0.0 — 2026-10-21
- Initial release: side panel recorder (clicks, typing, selects, checkboxes, uploads, keys, navigations, tab switches),
  wait/page-load timing, notes, Markdown/JSON export and copy.
