# Danmaku Streaming Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream large Bilibili danmaku XML through bounded messages, parse it off the overlay UI thread, and feed CCL incrementally so IINA remains responsive while loading.

**Architecture:** `main.js` sends the XML in asynchronous 128 KiB chunks tagged with a stream ID. `overlay/parser-worker.js` uses the pure `overlay/danmaku-parser.js` streaming parser and sends small CCL-compatible batches. `overlay/danmaku.js` keeps received comments in a timestamp min-heap, sends due comments through CCL incrementally, and retains the comment history for seek recovery.

**Tech Stack:** IINA plugin JavaScript, WKWebView Web Worker, CommentCoreLibrary, Node.js built-in `node:test` runner, static `node --check` validation.

## Global Constraints

- Preserve CommentCoreLibrary and the existing BV/番剧 source channels.
- Keep the sidebar layout and existing source-selection/settings controls unchanged.
- Keep mode 1/2/4/5/6 support and discard mode 7/8/9.
- Carry the latest pause state in `stream-start.paused` and do not advance CCL while paused.
- Use `128 * 1024` UTF-16 characters as the maximum XML bridge chunk.
- Use batches of at most `200` parsed comments.
- Limit active CCL comments to `240` DOM objects.
- Ordinary playback updates are sent at most every `33` ms; seeks and control transitions are immediate.
- Do not add dependencies or modify `local.properties`.
- Do not stage or commit files unless the user explicitly requests it.

## File Map

- Create: `overlay/danmaku-parser.js` — dependency-free UMD parser and chunk accumulator shared by Node tests and the Worker.
- Create: `overlay/parser-worker.js` — Worker protocol adapter; no DOM access and no rendering logic.
- Modify: `overlay/danmaku.html` — load the pure parser before `danmaku.js` so the Worker fallback can use the same implementation.
- Modify: `overlay/danmaku.js` — replace full `CommentProvider` loading with Worker/fallback streaming and incremental CCL timeline management.
- Modify: `main.js` — replace one-shot XML bridge messages with cancellable asynchronous chunks and throttle mpv time forwarding.
- Create: `tests/danmaku-parser.test.js` — parser field, entity, mode-filter, chunk-boundary, batching, and flush tests.
- Create: `tests/parser-worker.test.js` — Worker protocol test using a Node VM harness.
- Create: `tests/danmaku-overlay.test.js` — overlay stream-state test with a minimal fake DOM, CCL manager, and Worker.
- Create: `tests/main-stream.test.js` — main-entry test with mocked IINA APIs, HTTP responses, timers, and overlay message capture.
- Reference only: `docs/superpowers/specs/2026-09-13-danmaku-streaming-performance-design.md`.

---

### Task 1: Build the Pure Streaming Parser

**Files:**
- Create: `overlay/danmaku-parser.js`
- Test: `tests/danmaku-parser.test.js`

**Interfaces:**
- Consumes: Complete or partial XML strings containing standard Bilibili `<d p="...">text</d>` records.
- Produces: `parseCommentToken(token)` returning a CCL `CommentData` object or `null`; `createStreamingParser(onBatch, batchSize)` returning `{ push, finish, stats }`.

- [x] **Step 1: Write the failing parser tests**

Create `tests/danmaku-parser.test.js` with the following assertions:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseCommentToken,
    createStreamingParser
} = require("../overlay/danmaku-parser.js");

test("parses supported Bilibili fields into CCL data", () => {
    const comment = parseCommentToken(
        '<d p="1.25,1,30,16711680,1700000000,0,hash,123">hello</d>'
    );

    assert.deepEqual(comment, {
        stime: 1250,
        size: 30,
        color: 16711680,
        mode: 1,
        date: 1700000000,
        pool: 0,
        position: "absolute",
        dbid: 123,
        hash: "hash",
        border: false,
        text: "hello"
    });
});

test("decodes XML entities and normalizes Bilibili newlines", () => {
    const comment = parseCommentToken(
        '<d p="2,4,25,16777215,1,0,h,2">&lt;hi&gt;&amp;one/n\\ntwo\r\nthree</d>'
    );

    assert.equal(comment.text, "<hi>&one\ntwo\nthree");
});

test("discards unsupported modes and malformed records", () => {
    assert.equal(parseCommentToken('<d p="1,7,25,1,1,0,h,1">advanced</d>'), null);
    assert.equal(parseCommentToken('<d p="1,8,25,1,1,0,h,1">code</d>'), null);
    assert.equal(parseCommentToken('<d p="1,9,25,1,1,0,h,1">bas</d>'), null);
    assert.equal(parseCommentToken('<d p="bad,1,25,1">bad</d>'), null);
    assert.equal(parseCommentToken("not a comment"), null);
});

test("handles records split at arbitrary chunk boundaries", () => {
    const xml =
        '<i><d p="0.5,1,25,1,1,0,a,1">a&amp;b</d>' +
        '<d p="1.5,5,25,2,1,0,b,2">top</d></i>';
    const expected = [
        { stime: 500, size: 25, color: 1, mode: 1, date: 1, pool: 0,
          position: "absolute", dbid: 1, hash: "a", border: false, text: "a&b" },
        { stime: 1500, size: 25, color: 2, mode: 5, date: 1, pool: 0,
          position: "absolute", dbid: 2, hash: "b", border: false, text: "top" }
    ];
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 2);

    for (let i = 0; i < xml.length; i += 1) {
        parser.push(xml.slice(i, i + 1));
    }
    parser.finish();

    assert.deepEqual(output, expected);
    assert.deepEqual(parser.stats(), { parsed: 2, accepted: 2, skipped: 0 });
});

test("flushes complete trailing records and ignores incomplete input", () => {
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 1);

    parser.push('<d p="3,1,25,1,1,0,h,3">complete</d><d p="4,1,25');
    parser.finish();

    assert.equal(output.length, 1);
    assert.equal(output[0].text, "complete");
    assert.deepEqual(parser.stats(), { parsed: 1, accepted: 1, skipped: 1 });
});

test("never emits a batch larger than the configured size", () => {
    const batches = [];
    const parser = createStreamingParser((batch) => batches.push(batch), 2);
    parser.push(
        '<d p="1,1,25,1,1,0,a,1">a</d>' +
        '<d p="2,1,25,1,1,0,b,2">b</d>' +
        '<d p="3,1,25,1,1,0,c,3">c</d>'
    );
    parser.finish();

    assert.deepEqual(batches.map((batch) => batch.length), [2, 1]);
});
```

- [x] **Step 2: Run the parser tests and verify the expected RED failure**

Run:

```bash
node --test tests/danmaku-parser.test.js
```

Expected: FAIL because `../overlay/danmaku-parser.js` does not exist yet. If the test runner reports a syntax or assertion error instead, fix the test before writing production code.

- [x] **Step 3: Implement the minimal UMD parser**

Create `overlay/danmaku-parser.js` with this implementation shape and exact public API:

```js
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.BiliDanmakuParser = factory();
    }
}(typeof self !== "undefined" ? self : this, function () {
    const DEFAULT_BATCH_SIZE = 200;

    function decodeXmlEntities(text) {
        return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
            (match, entity) => {
                const lower = entity.toLowerCase();
                if (lower === "amp") return "&";
                if (lower === "lt") return "<";
                if (lower === "gt") return ">";
                if (lower === "quot") return '"';
                if (lower === "apos") return "'";
                const code = lower.startsWith("#x")
                    ? parseInt(lower.slice(2), 16)
                    : parseInt(lower.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            });
    }

    function parseInteger(value) {
        const normalized = String(value || "").trim();
        if (!/^\d+$/.test(normalized)) return null;
        const parsed = Number(normalized);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    function parseCommentToken(token) {
        const opening = /^<d\b([^>]*)>/.exec(token);
        const closing = /<\/d>$/.exec(token);
        if (!opening || !closing) return null;

        const pMatch = /^p="([^"]*)"$/.exec(opening[1]);
        if (!pMatch) return null;
        const params = pMatch[1].split(",");
        if (params.length !== 8) return null;

        const rawTime = String(params[0] || "").trim();
        if (!/^\d+(?:\.\d+)?$/.test(rawTime)) return null;
        const time = Number(rawTime);
        const mode = parseInteger(params[1]);
        const size = parseInteger(params[2]);
        const color = parseInteger(params[3]);
        if (!Number.isFinite(time) || mode === null || size === null || color === null ||
            size <= 0 || color > 0xffffff) return null;
        if (![1, 2, 4, 5, 6].includes(mode)) return null;

        const contentStart = opening[0].length;
        const contentEnd = token.length - closing[0].length;
        const rawText = token.slice(contentStart, contentEnd);
        if (rawText.includes("<") ||
            /&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(rawText)) {
            return null;
        }
        const stime = time * 1000;
        const normalizedStime = Math.round(stime);
        if (!Number.isSafeInteger(normalizedStime) || normalizedStime < 0) return null;
        const text = decodeXmlEntities(rawText)
            .replace(/(\/n|\\n|\r\n|\n|\r)/g, "\n")
            .replace(/\u25a0/g, "\u2588");
        const date = parseInteger(params[4]);
        const pool = parseInteger(params[5]);
        const dbid = parseInteger(params[7]);
        if (date === null || pool === null || dbid === null) return null;
        return {
            stime: normalizedStime, size: size, color: color, mode: mode,
            date: date, pool: pool, position: "absolute", hash: params[6],
            dbid: dbid, border: false, text: text
        };
    }

    function createStreamingParser(onBatch, batchSize) {
        if (typeof onBatch !== "function") {
            throw new TypeError("onBatch must be a function");
        }
        const state = {
            buffer: "",
            batch: [],
            batchSize: Number.isInteger(batchSize) && batchSize > 0
                ? batchSize : DEFAULT_BATCH_SIZE,
            parsed: 0,
            accepted: 0,
            skipped: 0
        };
        const stats = () => ({
            parsed: state.parsed,
            accepted: state.accepted,
            skipped: state.skipped
        });
        const emit = () => {
            if (state.batch.length === 0) return;
            const batch = state.batch;
            state.batch = [];
            onBatch(batch, stats());
        };
        const consume = (final) => {
            while (state.buffer.length > 0) {
                const start = state.buffer.search(/<d\b/i);
                if (start < 0) {
                    state.buffer = final ? "" : state.buffer.slice(-1);
                    return;
                }
                if (start > 0) state.buffer = state.buffer.slice(start);
                const openEnd = state.buffer.indexOf(">");
                if (openEnd < 0) {
                    if (final) state.buffer = "";
                    return;
                }
                const close = /<\/d\s*>/i.exec(state.buffer.slice(openEnd + 1));
                if (!close) {
                    if (final) state.buffer = "";
                    return;
                }
                const end = openEnd + 1 + close.index + close[0].length;
                const token = state.buffer.slice(0, end);
                state.buffer = state.buffer.slice(end);
                state.parsed += 1;
                const comment = parseCommentToken(token);
                if (!comment) {
                    state.skipped += 1;
                    continue;
                }
                state.accepted += 1;
                state.batch.push(comment);
                if (state.batch.length >= state.batchSize) emit();
            }
        };
        return {
            push(chunk) {
                if (typeof chunk !== "string" || chunk.length === 0) return stats();
                state.buffer += chunk;
                consume(false);
                return stats();
            },
            finish() {
                const hadIncompleteInput = state.buffer.trim().length > 0;
                consume(true);
                if (hadIncompleteInput) state.skipped += 1;
                state.buffer = "";
                emit();
                return stats();
            },
            stats
        };
    }

    return { DEFAULT_BATCH_SIZE, parseCommentToken, createStreamingParser };
}));
```

- [x] **Step 4: Run the parser tests and verify GREEN**

Run:

```bash
node --test tests/danmaku-parser.test.js
```

Expected: all parser tests PASS with no warnings. Do not proceed while the parser tests are red.

### Task 2: Add the Parser Worker Protocol

**Files:**
- Create: `overlay/parser-worker.js`
- Test: `tests/parser-worker.test.js`

**Interfaces:**
- Consumes: `start`, `chunk`, `end`, and `cancel` messages with a numeric `streamId`.
- Produces: `comments`, `progress`, `complete`, and `error` messages carrying the same `streamId`.

- [x] **Step 1: Write the failing Worker protocol test**

Create a Node VM harness that implements `importScripts()` by evaluating `overlay/danmaku-parser.js`, captures `self.postMessage()` output, starts stream `7`, sends a record split across two chunks, ends it, and asserts one `comments` and one `complete` message. Also send a stale chunk for stream `6` and assert it produces no message. The Worker should emit a parsed batch before `end`; timestamp ordering is verified in the overlay scheduler test.

```js
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

test("worker parses only the current stream and reports completion", () => {
    const messages = [];
    const context = { console, setTimeout };
    context.self = {
        postMessage(message) { messages.push(message); }
    };
    context.importScripts = (name) => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "overlay", name), "utf8"
        );
        vm.runInContext(source, context);
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, "..", "overlay", "parser-worker.js"), "utf8"),
        context
    );

    context.self.onmessage({ data: { type: "start", streamId: 7 } });
    context.self.onmessage({ data: {
        type: "chunk", streamId: 6, chunk: '<d p="9,1,25,1">stale</d>'
    } });
    context.self.onmessage({ data: {
        type: "chunk", streamId: 7, chunk: '<d p="1,1,25,1,1,0,h,1">hel'
    } });
    context.self.onmessage({ data: {
        type: "chunk", streamId: 7, chunk: 'lo</d>'
    } });
    context.self.onmessage({ data: { type: "end", streamId: 7 } });

    assert.equal(messages.filter((m) => m.type === "comments").length, 1);
    assert.equal(messages.filter((m) => m.type === "comments")[0].comments[0].text, "hello");
    assert.deepEqual(messages.find((m) => m.type === "complete"), {
        type: "complete", streamId: 7, parsed: 1, accepted: 1, skipped: 0
    });
});
```

- [x] **Step 2: Run the Worker test and verify the expected RED failure**

Run:

```bash
node --test tests/parser-worker.test.js
```

Expected: FAIL because `overlay/parser-worker.js` does not exist yet.

- [x] **Step 3: Implement the Worker adapter**

Create `overlay/parser-worker.js`:

```js
importScripts("danmaku-parser.js");

let activeStreamId = null;
let parser = null;

function report(type, streamId, stats) {
    self.postMessage(Object.assign({ type, streamId }, stats));
}

function startStream(streamId) {
    activeStreamId = streamId;
    parser = BiliDanmakuParser.createStreamingParser((comments, stats) => {
        report("comments", streamId, {
            comments, parsed: stats.parsed,
            accepted: stats.accepted, skipped: stats.skipped
        });
    }, 200);
    report("progress", streamId, parser.stats());
}

self.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "start") {
        startStream(data.streamId);
        return;
    }
    if (data.streamId !== activeStreamId || !parser) return;
    try {
        if (data.type === "chunk") {
            const stats = parser.push(data.chunk || "");
            report("progress", data.streamId, stats);
        } else if (data.type === "end") {
            const stats = parser.finish();
            report("complete", data.streamId, stats);
            parser = null;
        } else if (data.type === "cancel") {
            parser = null;
            activeStreamId = null;
        }
    } catch (error) {
        report("error", data.streamId, {
            message: String((error && error.message) || error)
        });
        parser = null;
    }
};
```

- [x] **Step 4: Run the Worker test and verify GREEN**

Run:

```bash
node --test tests/danmaku-parser.test.js tests/parser-worker.test.js
```

Expected: all parser and Worker protocol tests PASS.

### Task 3: Replace Full Provider Loading in the Overlay

**Files:**
- Modify: `overlay/danmaku.js`
- Modify: `overlay/danmaku.html`
- Test: `tests/danmaku-overlay.test.js`

**Interfaces:**
- Consumes: `stream-start`, `stream-chunk`, `stream-end`, `time`, `pause`, `filter`, `style`, `resize`, and `clear` messages.
- Produces: `stream-state`, `loaded`, and `overlay-error` messages; `stream-state` always includes `streamId` and phase/count fields when available.

- [x] **Step 1: Write the failing overlay stream test**

Use a VM fixture with fake `document`, `CommentManager`, `Worker`, and `iina` message registration. Assert that `stream-start` creates one manager with `options.limit === 240`, a Worker is started, a Worker `comments` message appends to `cm.timeline` and the due-comment heap, and a font-size `style` message changes queued comment sizes without creating a second provider or Worker. Include an out-of-order batch and assert due comments are sent progressively in timestamp order.

```js
test("overlay accepts comment batches without rebuilding a provider", () => {
    // The fixture exposes fake iina.handlers, fakeWorker, and fakeManager.
    sendOverlay("stream-start", {
        streamId: 3, title: "Demo", paused: true, settings: { fontSize: 25, speed: 680,
            showTop: true, showBottom: true }, initialTime: 0
    });
    fakeWorker.emit({ type: "comments", streamId: 3, comments: [
        { stime: 0, mode: 1, size: 18, text: "first" }
    ], parsed: 1, accepted: 1, skipped: 0 });
    sendOverlay("style", { fontSize: 32 });

    assert.equal(fakeManager.options.limit, 240);
    assert.equal(fakeManager.timeline.length, 1);
    assert.equal(fakeManager.timeline[0].size, 32);
    assert.equal(fakeWorker.createdCount, 1);
    assert.equal(fakeProviderCreated, 0);
    assert.equal(outgoing.some((m) => m.name === "stream-state" &&
        m.data.phase === "available"), true);
});
```

- [x] **Step 2: Run the overlay test and verify the expected RED failure**

Run:

```bash
node --test tests/danmaku-overlay.test.js
```

Expected: FAIL because the current overlay only handles `load` and rebuilds `CommentProvider`.

- [x] **Step 3: Implement the incremental overlay path**

In `overlay/danmaku.js`, remove `provider`, `cachedXml`, `cachedTitle`, `scaledXml()`, `buildProvider()`, and the `load` listener. Add these state variables and operations:

```js
let parserWorker = null;
let fallbackParser = null;
let activeStreamId = null;
let currentTitle = "";
let currentTime = 0;
let hasTime = false;
let paused = false;
let streamAvailable = false;
let progressReportedAt = 0;

function resetManager() {
    cm.clear();
    cm.timeline = [];
    cm.position = 0;
    cm.seek(0);
    cm._lastPosition = 0;
}

function appendComments(streamId, comments, stats) {
    if (streamId !== activeStreamId || !cm) return;
    comments.forEach((comment) => { comment.size = ov.fontSize; });
    cm.timeline.push(...comments);
    if (!streamAvailable && comments.length > 0) {
        streamAvailable = true;
        iina.postMessage("stream-state", {
            streamId, phase: "available", parsed: stats.parsed,
            accepted: stats.accepted, skipped: stats.skipped
        });
        iina.postMessage("loaded", { streamId, title: currentTitle,
            accepted: stats.accepted });
    }
    if (hasTime && !paused) flushDueComments(currentTime);
}

function applyFontSize() {
    if (!cm) return;
    cm.timeline.forEach((comment) => { comment.size = ov.fontSize; });
    cm.runline.forEach((comment) => { comment.size = ov.fontSize; });
}
```

Keep `ensureCM()` as the only manager construction point, set `cm.options.limit = 240` after construction, and call `cm.start()` once. On `stream-start`, terminate/cancel the previous parser, reset the manager and comment queues, copy settings, set `currentTime` from `initialTime`, set `streamAvailable = false`, create `new Worker("parser-worker.js")`, and post `{ type: "start", streamId }`. If Worker construction throws, create `fallbackParser` with the same parser module and consume fallback chunks via bounded `setTimeout` slices.

Add `<script src="danmaku-parser.js"></script>` to `overlay/danmaku.html` immediately before `<script src="danmaku.js"></script>` so the fallback sees `window.BiliDanmakuParser`.

Worker messages must be ignored unless their `streamId` equals `activeStreamId`. `comments` enters the timestamp min-heap through `appendComments()`, which sends only due comments to CCL and emits `available` on the first accepted batch. `progress` emits `stream-state` with phase `parsing` no more than once every 400 ms. `complete` emits `complete` when `accepted > 0`, otherwise `empty`. `error` emits `overlay-error` and `stream-state` phase `error` for the current stream only.

Keep the existing top/bottom filter and opacity behavior. Change the `style` listener so speed still calls `resize()`, while font size updates `ov.fontSize` and calls `applyFontSize()` without reparsing. Change the `time` listener to update `currentTime`, clear and rebuild the pending heap on backward movement or a jump larger than 5.5 seconds, then flush due comments through CCL. Preserve pause, visibility, resize, and clear handlers; clear must invalidate the active stream and stop accepting old batches.

- [x] **Step 4: Run the overlay test and verify GREEN**

Run:

```bash
node --test tests/danmaku-parser.test.js tests/parser-worker.test.js tests/danmaku-overlay.test.js
```

Expected: all three groups PASS, including the assertion that font-size changes do not create another Worker/provider.

### Task 4: Stream XML from the Main Entry and Throttle Time IPC

**Files:**
- Modify: `main.js`
- Test: `tests/main-stream.test.js`

**Interfaces:**
- Consumes: Existing `load-source`, API responses, mpv time events, and clear/end-file events.
- Produces: `stream-start`, `stream-chunk`, and `stream-end` messages; status messages for download, transfer, parsing, availability, completion, empty, and error phases.

- [x] **Step 1: Write the failing main-entry test**

Mock `iina.http.get()` to return one BV view response and one XML response, evaluate `main.js` in a VM, invoke the captured `load-source` handler, and assert that no `load` message contains XML, every `stream-chunk` is at most `128 * 1024` characters, and a tight burst of mpv time events produces at most one ordinary time message per 33 ms of mocked time. Include a second assertion that advancing the mocked clock produces the next chunk and that a newer load prevents old scheduled chunks from being sent.

```js
test("main streams bounded chunks and throttles ordinary time updates", async () => {
    await loadMainFixture();
    await sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await settleTimers();

    assert.equal(overlayMessages.some((message) => message.name === "load"), false);
    const chunks = overlayMessages
        .filter((message) => message.name === "stream-chunk")
        .map((message) => message.data.chunk);
    assert.equal(chunks.length > 0, true);
    assert.equal(chunks.every((chunk) => chunk.length <= 128 * 1024), true);

    clock.now = 1000;
    eventHandlers["mpv.time-pos.changed"](10);
    eventHandlers["mpv.time-pos.changed"](10.01);
    eventHandlers["mpv.time-pos.changed"](10.02);
    assert.equal(timeMessagesSinceLastCheck(), 1);
    clock.now = 1033;
    eventHandlers["mpv.time-pos.changed"](10.05);
    assert.equal(timeMessagesSinceLastCheck(), 2);
});
```

- [x] **Step 2: Run the main-entry test and verify the expected RED failure**

Run:

```bash
node --test tests/main-stream.test.js
```

Expected: FAIL because the current main entry sends one `load` message and forwards every time event.

- [x] **Step 3: Implement cancellable XML chunking**

Replace `pendingXml` with a pending stream payload and add these main-entry primitives near the overlay state:

```js
const XML_CHUNK_SIZE = 128 * 1024;
let nextStreamId = 0;
let currentStreamId = 0;
let streamPumpGeneration = 0;
let pendingStream = null;

function startOverlayStream(payload) {
    const generation = ++streamPumpGeneration;
    let xml = payload.xml;
    let offset = 0;
    sidebar.postMessage("status", { text: "弹幕数据已下载，正在传输…" });
    overlay.postMessage("stream-start", {
        streamId: payload.streamId,
        title: payload.title,
        settings: payload.settings,
        paused: playbackPaused,
        initialTime: latestPlaybackTime === null
            ? 0
            : latestPlaybackTime + settings.offset
    });

    function pump() {
        if (generation !== streamPumpGeneration || !overlayLoaded) return;
        if (offset >= xml.length) {
            overlay.postMessage("stream-end", { streamId: payload.streamId });
            xml = "";
            return;
        }
        const chunk = xml.slice(offset, offset + XML_CHUNK_SIZE);
        offset += chunk.length;
        overlay.postMessage("stream-chunk", {
            streamId: payload.streamId, chunk: chunk
        });
        setTimeout(pump, 0);
    }
    pump();
}

function pushToOverlay(xml) {
    const payload = {
        streamId: ++nextStreamId,
        xml: xml,
        title: video.title,
        settings: overlaySettings()
    };
    currentStreamId = payload.streamId;
    danmakuActive = false;
    streamPumpGeneration += 1;
    if (!overlayRequested) {
        overlay.loadFile("overlay/danmaku.html");
        overlayRequested = true;
    }
    overlay.setClickable(false);
    if (overlayLoaded) {
        startOverlayStream(payload);
    } else {
        pendingStream = payload;
        sidebar.postMessage("status", { text: "弹幕数据已下载，等待渲染器…" });
    }
}
```

Register `stream-state` and `loaded` handlers alongside the existing overlay handlers. They must ignore non-current stream IDs, set `danmakuActive = true` on `available`, keep `streamLoading` true only through parsing/available/complete-with-comments, forward throttled parse progress to the existing sidebar status line, and show the final loaded/empty/error text. `loadSource()`, `search-bangumi`, `select-season`, and `select-part` must invalidate the current stream before starting their new request. `loadPart()` must no longer set `danmakuActive = true` before the first accepted batch.

On overlay readiness, start only the latest `pendingStream`. On clear and end-file, increment `streamPumpGeneration`, invalidate `currentStreamId`, null the pending payload, set `danmakuActive = false`, and send `clear` to the overlay.

- [x] **Step 4: Implement 33 ms playback forwarding with immediate jumps**

Replace the current time event body with this behavior:

```js
let latestPlaybackTime = null;
let lastSentPlaybackTime = null;
let lastTimeSentAt = 0;
const TIME_UPDATE_INTERVAL = 33;

function syncPlaybackTime(time, force) {
    if (!Number.isFinite(time)) return;
    latestPlaybackTime = time;
    if (!danmakuActive || !overlayLoaded) return;
    const now = Date.now();
    const jump = lastSentPlaybackTime === null ||
        time < lastSentPlaybackTime - 0.25 ||
        Math.abs(time - lastSentPlaybackTime) > 1;
    if (!force && !jump && now - lastTimeSentAt < TIME_UPDATE_INTERVAL) return;
    lastSentPlaybackTime = time;
    lastTimeSentAt = now;
    overlay.postMessage("time", { time: time + settings.offset });
}

event.on("mpv.time-pos.changed", (time) => syncPlaybackTime(time, false));
```

Use `syncPlaybackTime(latestPlaybackTime, true)` after an offset change and on overlay readiness when a stream is active. Cache pause state even before availability, include it in `stream-start`, and send pause immediately for a current loading stream. Keep resize messages immediate. Stop the chunk pump on either `stream-state(error)` or a standalone `overlay-error`.

- [x] **Step 5: Run the main-entry and combined tests**

Run:

```bash
node --test tests/danmaku-parser.test.js tests/parser-worker.test.js tests/danmaku-overlay.test.js tests/main-stream.test.js
```

Expected: all tests PASS, with no unhandled promise rejection or timer warning.

### Task 5: Static and Runtime Verification

**Files:**
- Verify: `main.js`
- Verify: `overlay/danmaku.js`
- Verify: `overlay/danmaku-parser.js`
- Verify: `overlay/parser-worker.js`

- [x] **Step 1: Run the complete automated suite**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS for every test.

- [x] **Step 2: Run JavaScript syntax checks**

Run:

```bash
node --check main.js
node --check overlay/danmaku.js
node --check overlay/danmaku-parser.js
node --check overlay/parser-worker.js
```

Expected: all four commands exit successfully with no output.

- [x] **Step 3: Inspect the final diff for scope and stale paths**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm there is no `overlay/danmaku.js` reference to `cachedXml`, `scaledXml`, `CommentProvider`, or a one-shot `postMessage("load", ...)`, and no unrelated file was changed.

- [ ] **Step 4: Perform manual IINA verification**

While a local video is playing, load a dense BV source and verify:

- The local video continues playing while XML is transferred and parsed.
- The sidebar moves through download, transfer, parsing, available, and complete states.
- The first danmaku appears before parsing completes.
- Unsupported modes do not render, and empty XML reports `暂无弹幕`.
- Seek forward/backward, pause/resume, resize, toggle, top/bottom filters, opacity, speed, font size, offset, and clear still work.
- Selecting another part/source stops old progress and old comments cannot reappear.
- Network/API errors and Worker errors leave the sidebar available for another load.

- [x] **Step 5: Run the independent audit** — 2026-09-24 fresh `goal-verify` review: CONDITIONAL PASS; no BLOCKER, one MAJOR remains because the required real-IINA streaming matrix in Step 4 is not yet verified. Automated tests and syntax checks pass; this does not substitute for the pending device validation.

Dispatch a fresh read-only `goal-verify` audit against the final diff and the approved design. Require checks for requirements, logic, edge cases, code quality, non-tautological tests, and actual test/runtime results. Fix all BLOCKER findings and cheap MAJOR findings, then rerun the audit before delivery.
