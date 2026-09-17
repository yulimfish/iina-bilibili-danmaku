---
name: iina-plugin-real-device-debugging
description: Use when debugging or verifying an IINA JavaScript plugin on a real macOS/IINA installation, especially failures that fixtures miss such as sidebar listeners cleared by loadFile, WKWebView file:// Worker failures, overlay thread crashes, plugin reload issues, or playback-state regressions.
---

# IINA Plugin Real-Device Debugging

Use this workflow for `iina-bilibili-danmaku` and structurally similar IINA JavaScript plugins. It converts a source change into reproducible real-device evidence without treating unit tests as proof of IINA/WKWebView behavior.

## Inputs

- Source repository path and current Git status.
- Installed plugin directory or an installable `.iinaplgz`.
- Exact IINA and macOS versions.
- Scenario, expected state, and observable pass condition.

Do not start by automating the UI. First define the smallest scenario that can disprove the fix.

## 1. Establish The Source Baseline

Run the bundled preflight from the skill directory:

```bash
node scripts/preflight.mjs /absolute/path/to/iina-plugin-repo
```

It checks `Info.json`, runtime entry files, JavaScript syntax, and the repository's Node tests. Stop on any failure. Record the baseline commit and preserve unrelated worktree changes.

## 2. Deploy The Smallest Runtime Diff

1. Identify exactly which runtime files changed.
2. Copy only those files into the installed plugin directory, preserving relative paths.
3. Do not replace the whole installed plugin unless validating a release package.
4. Record source path, destination path, and checksum or byte comparison for every copied file.

When testing a package, inspect the ZIP contents first and reject tests/docs/Git metadata in the runtime archive.

## 3. Reload IINA Deliberately

1. Bring IINA to the foreground.
2. Use IINA's “Reload All Plugins” action; restart IINA only when reload cannot reset the relevant runtime.
3. Reopen the plugin panel and repeat the same scenario from a known state.
4. Use macOS accessibility automation only after confirming the visible target. Never use blind coordinates when an accessibility element or menu title is available.

For native-window evidence, load the `screenshot` skill and save captures to the temporary directory unless the user requests another path.

## 4. Observe Through A Reliable Channel

Prefer, in order:

1. User-visible sidebar status text or HUD state.
2. Screenshot or short recording of the final UI state.
3. A temporary, explicit status message sent through the plugin's existing message channel.
4. Crash report under `~/Library/Logs/DiagnosticReports/`.

Do not rely on plugin `console` output reaching macOS unified logs. In the verified IINA 1.4.4 workflow it did not; sidebar status text was the reliable feedback channel.

## 5. Reproduce Real Runtime Constraints

Fixtures and fixes must account for these verified constraints when relevant:

- `sidebar.loadFile()` can clear listeners registered before it; register handlers after loading.
- WKWebView `file://` pages may fail to load Worker scripts; verify the fallback path with real content.
- Overlay API calls can cross IINA's background JavaScript queue; defer UI-sensitive calls until the overlay reports ready.
- Real Bilibili XML can contain 9+ parameters and 64-bit identifiers; test with captured real payload shape, not only synthetic fixtures.
- CSS library selectors such as `.abp` and `.container` can be required for visible rendering even when data flow succeeds.

Treat this list as hypotheses to verify, not a license to change unrelated code.

## 6. Run The Real-Device Matrix

For playback or timing changes, cover only the dimensions affected by the change. The established matrix is:

- `0.5x / 1x / 2x`
- playing and paused
- forward seek, backward seek, and drag-release
- old overlay state cleared and final position rebuilt
- no crash, permanent loading state, or visible stall

For other changes, replace the matrix with equivalent scenario-specific dimensions. Never claim broad compatibility from one IINA/macOS combination.

## 7. Close The Loop

Before reporting success:

1. Re-run the bundled preflight against the final source tree.
2. Confirm the installed files match the intended source files.
3. Capture the pass evidence and exact environment versions.
4. Update tests so the newly discovered runtime constraint is represented where feasible.
5. State any untested combinations explicitly.

Use this result format:

```text
RESULT: PASS | FAIL | BLOCKED
SOURCE: <commit + changed runtime files>
ENV: <macOS + IINA version>
SCENARIO: <exact steps>
EVIDENCE: <status text / screenshot / crash report>
UNTESTED: <remaining combinations>
```

## Evidence Origin

This draft was promoted from repeated successful traces documented by `mem_1789308781671_nijiqffsy`, `mem_1789568781472_613rr6pot`, and the 2026-09-17 Dream report. It remains a draft until it is invoked successfully on another IINA plugin change and passes independent review.
