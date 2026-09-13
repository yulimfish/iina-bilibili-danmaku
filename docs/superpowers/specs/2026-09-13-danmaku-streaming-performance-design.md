# Danmaku Streaming Performance Design

**Date:** 2026-09-13

**Status:** Implemented; automated verification passed; manual IINA validation pending

## Goal

Load large Bilibili danmaku XML without freezing IINA, show the first usable danmaku as soon as possible, keep later comments loading progressively, and preserve the current Bilibili channels, CCL rendering behavior, controls, and sidebar layout.

The chosen priority is playback responsiveness over waiting for a complete parse. Danmaku may appear progressively while the rest of the source is still being parsed.

## Current Bottlenecks

- `main.js` forwards one entire XML string through `overlay.postMessage("load", payload)`. Large strings create a large cross-WebView serialization and copy operation.
- `overlay/danmaku.js` calls `BilibiliFormat.TextParser.parseMany()` synchronously. The parser creates a DOM representation for the entire XML before any comment can be shown.
- `buildProvider()` destroys and recreates the CCL provider when the font size changes, so a visual setting can repeat the full parse and cause another long pause.
- CCL's default `CommentManager.options.limit` is `0`, leaving active DOM comment count unbounded during dense or delayed streams.
- `main.js` forwards every `mpv.time-pos.changed` event, even though the overlay animation itself already runs on `requestAnimationFrame`.

## Non-goals

- Do not replace CommentCoreLibrary.
- Do not add Bilibili login, caching, offline playback, live danmaku, or advanced danmaku support.
- Do not change the sidebar layout or the existing source-selection and settings controls.
- Do not change the supported danmaku modes: mode 1/2/4/5/6 remain supported; mode 7/8/9 remain discarded.

## Architecture

The load path becomes a bounded stream:

```text
Bilibili HTTP response
        |
        v
main.js: 128 KiB asynchronous chunks
        |
        v
overlay webview: parser Worker
        |  batches of at most 200 CommentData objects
        v
overlay/danmaku.js: incremental CCL timeline
        |
        v
CCL CommentManager: only comments due at the current playback time
```

The overlay remains responsible for rendering and time synchronization. The parser Worker is responsible only for converting complete Bilibili `<d>` records into CCL-compatible data and emitting small batches. The Worker never creates DOM nodes and is terminated or superseded by a newer stream when a load is cancelled. Bilibili XML records are not guaranteed to be ordered by playback time, so the overlay keeps a min-heap of received comments and only sends due comments to CCL.

## Components and Interfaces

### `main.js`

Replace the single-message XML load with an asynchronous stream identified by a monotonically increasing `streamId`.

Messages sent to the overlay:

- `stream-start`: `{ streamId, title, settings, initialTime, paused }`
- `stream-chunk`: `{ streamId, chunk }`, where `chunk` is at most `128 * 1024` UTF-16 characters
- `stream-end`: `{ streamId }`
- Existing `time`, `pause`, `filter`, `style`, `resize`, and `clear` messages remain in use.

Chunks are sent from a short `setTimeout` continuation rather than a tight loop. A newer stream increments the stream generation; scheduled continuations for the old stream then stop without sending more data.

Playback time handling changes as follows:

- Cache the latest finite mpv position even before the overlay is ready.
- Send ordinary position updates no more than once every 33 ms.
- Send the first position, backward movement, large jumps, and control-state transitions immediately.
- Include the cached latest position in `stream-start` so the first parsed batch is aligned even if no new mpv event arrives during parsing.

The main entry keeps `danmakuActive` false until the overlay reports that the current stream has at least one accepted comment. `streamLoading` remains true while parsing so time and pause state can align comments that arrive later; it becomes false for empty, error, or cancelled streams, suppressing further playback IPC.

### `overlay/danmaku-parser.js`

Add a browser/Worker/CommonJS-compatible pure parser module. It exposes:

```js
parseCommentToken(token)
createStreamingParser(onBatch, batchSize)
```

`parseCommentToken()` reads the `p` attribute and text content from one complete `<d>` element and returns either a CCL `CommentData` object or `null`.

The returned object preserves the fields required by the current CCL Bilibili parser: `stime` in milliseconds, `size`, `color`, `mode`, `date`, `pool`, `hash`, `dbid` when present, `position: "absolute"`, `border: false`, and normalized `text`. It decodes standard XML entities and converts the existing Bilibili newline spellings to `\n`.

The parser accepts only the standard lowercase `<d>` element with its single `p` attribute and plain XML text content. It rejects malformed records, negative/non-safe timestamps, and modes 7, 8, and 9. It consumes arbitrary chunk boundaries by retaining only the incomplete record at the end of its input buffer. The default output batch size is 200 accepted comments.

### `overlay/parser-worker.js`

Import `danmaku-parser.js` and handle these messages:

- `{ type: "start", streamId }`: discard old parser state and start a new stream.
- `{ type: "chunk", streamId, chunk }`: consume the chunk if its ID is current.
- `{ type: "end", streamId }`: flush the final complete record and report completion after all comment batches.
- `{ type: "cancel", streamId }`: discard the current stream.

Worker output messages:

- `comments`: `{ streamId, comments, parsed, accepted, skipped }`
- `progress`: `{ streamId, parsed, accepted, skipped }`
- `complete`: `{ streamId, parsed, accepted, skipped }`
- `error`: `{ streamId, message }`

The Worker reports counts, not the raw XML, so progress updates stay small.

### `overlay/danmaku.js`

Remove the CCL `CommentProvider`, the cached XML, `scaledXml()`, and provider rebuilds. Create one `CommentManager` and configure it once:

- Keep `allowUnknownTypes = false` and the existing top/bottom filters.
- Set `cm.options.limit = 240` to bound active comment DOM nodes.
- Keep CCL's `requestAnimationFrame` animation loop.

For each current stream, reset the manager's visible comments, timeline, comment history, and pending min-heap. Append received batches to the history/timeline and heap them by Bilibili timestamp. Drain only comments with `stime <= currentTime` through CCL's normal `cm.send()` path, so records can render progressively even when the source XML is out of order; future comments remain queued until their timestamp. On a backward seek or a large jump, rebuild the heap from received comments at or after the new time, clear visible comments, and drain due comments without relying on CCL's sorted-timeline gate.

On a backward seek or a jump larger than the existing seek threshold, clear visible comments and reposition CCL before synchronizing. Old Worker messages are ignored by `streamId`.

Font-size changes update `size` on queued timeline objects and use CCL's `size` setter on active `runline` objects. They do not restart parsing or rebuild the provider. Speed, filters, opacity, pause, resize, visibility handling, and clear behavior remain live as before.

Overlay state transitions are reported once per meaningful phase:

```text
streaming -> parsing -> available -> complete
                         \-> empty
                         \-> error
```

`available` is emitted on the first accepted batch. Progress counts are throttled before forwarding to the sidebar so parsing feedback cannot become another message flood. Existing `loaded` and `overlay-error` notifications may be retained as compatibility aliases for the current main listener, but stream identity must be included in all load-related notifications.

If Worker construction is unavailable, use the same pure streaming parser in time-sliced `setTimeout` batches as a fallback. Each accepted batch enters the same overlay min-heap and is drained progressively. The fallback must yield between parser slices and must never call a full-document parser.

## Loading State and Visual Behavior

The existing sidebar status line is reused; no DOM hierarchy change is needed. Main and overlay report these user-visible states:

- `正在获取弹幕数据…`
- `弹幕数据已下载，正在传输…`
- `正在解析弹幕（已处理 N 条）…`
- `弹幕已可显示，正在继续解析…`
- `已加载「标题」`
- `暂无弹幕`
- `弹幕渲染失败，请重新加载`

The old rendered stream is cleared at `stream-start`, due comments begin appearing before the source finishes parsing, active DOM comments are capped, and a cancelled stream cannot reappear after a newer source is selected. These changes remove the long blank/frozen interval and avoid visual flicker caused by repeated full provider rebuilds.

## Error and Cancellation Rules

- HTTP and Bilibili API errors continue to use the existing `reportError()` messages.
- A stale `loadToken` must not start a stream or update the sidebar.
- A stale `streamId` must not append comments, change `danmakuActive`, or overwrite the current status.
- Worker parse errors end only the current stream and leave the plugin/sidebar usable for another load.
- `clear-danmaku` and `mpv.end-file` cancel pending chunk pumps, invalidate the active stream, clear CCL, and suppress later progress messages.
- Empty XML and XML containing only unsupported/malformed comments finish normally as `empty`, not as a renderer crash.

## Verification

Automated tests will run with Node's built-in test runner against the pure parser:

- Parse a normal mode 1/4/5/6 record into the expected CCL fields.
- Decode XML entities and normalize all supported newline spellings.
- Discard mode 7/8/9 and malformed `p` attributes.
- Split an element at every relevant boundary and verify the same batch output as an unsplit input.
- Flush a final complete record and ignore an incomplete trailing record.
- Verify output batches never exceed 200 accepted comments and counts are consistent.
- Verify overlay rendering drains due comments in timestamp order when Worker/fallback batches arrive out of order.

Static verification will run `node --check main.js`, `node --check overlay/danmaku.js`, `node --check overlay/danmaku-parser.js`, and `node --check overlay/parser-worker.js`.

Manual IINA verification will load a dense BV source while a local video is playing and confirm that playback remains responsive, the first batch appears before completion, progress advances, seek/pause/settings remain functional, switching source cancels the old stream, and empty/error states recover without restarting IINA.
