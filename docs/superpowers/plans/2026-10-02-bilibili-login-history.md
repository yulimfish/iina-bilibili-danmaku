# Bilibili Login and History Implementation Plan

**Goal:** Add optional QR/Cookie login with Keychain-only credential storage and cancellable daily history backfill, retaining anonymous XML/segment loading.
**Architecture:** Keep the existing IINA entry and sidebar message bridge; credentials stay in main.js, QR encoding is vendored locally, and backfill enriches an already displayed current pool.
**Scope:** main.js, Info.json, sidebar/index.html, sidebar/vendor, and targeted tests; preserve existing sidebar edits and never touch docs/superpowers/.DS_Store. No commit, push, release, or real IINA automation is authorized by this task.
- [x] Write failing auth tests: migration/no credential broadcasts, cookie validation, QR lifecycle/allowlisted ticket exchange, scoped logout, stale login races.
- [x] Implement main.js auth handlers and secure Keychain migration; validate before activating credentials and never include them in ordinary settings.
- [x] Write failing history tests: month/date enumeration, serial pacing, dmid merge, cancellation, partial failures, expired login, stale source results.
- [x] Implement bounded history backfill after current-pool playback starts; show progress and keep anonymous playback on failure or cancellation.
- [x] Implement approved sidebar controls and vendor a pinned MIT QR encoder locally with regression tests (independent workers; interrupted worker output completed by the main agent).
- [x] Run node --check main.js, node --test tests/*.test.js, git diff --check; perform an independent read-only audit, fix blocking findings, and explicitly identify unverified real-IINA/login behavior.

**Verification:** 216/216 tests passed, main.js syntax and diff checks passed. Independent goal-verify final snapshot PASS (source and fixture/mock only). An isolated 320px Chromium fixture verified local canvas QR rendering, cancellation/title cleanup, expired-credential logout and history action visibility without horizontal overflow. The vendored encoder executable bytes match qrcodejs@1.0.0 SHA-256 `c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36` after stripping the provenance comment.

**Not verified:** Actual IINA/WKWebView, macOS Keychain writes/permissions/deletion, mobile QR confirmation, authenticated crossDomain cookie delivery, or online daily history quantity. No commit or push performed.
