const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../overlay/danmaku-parser.js");

function wait(milliseconds = 0) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadOverlay(options = {}) {
    const outgoing = [];
    const handlers = {};
    const workers = [];
    let manager = null;
    let providerCreated = 0;

    class FakeCommentManager {
        constructor() {
            this.timeline = [];
            this.runline = [];
            this._accepting = true;
            this.options = { scroll: {} };
            this.filter = { allowUnknownTypes: true, allowTypes: {} };
            this.startCalls = 0;
            this.stopCalls = 0;
            this.timeCalls = 0;
            this.sendCalls = [];
            this.seekCalls = 0;
            this.clearCalls = 0;
            manager = this;
        }

        init() {}
        start() { this.startCalls += 1; this._accepting = true; }
        stop() { this.stopCalls += 1; this._accepting = false; }
        clear() { this.clearCalls += 1; this.runline = []; }
        seek() { this.seekCalls += 1; }
        time() { this.timeCalls += 1; }
        setHidden(hidden) { this._accepting = !hidden; this.runline = []; }
        validate(comment) {
            if (options.throwOnValidate) {
                throw new Error("synthetic validation failure");
            }
            return this.filter.allowTypes[comment.mode] !== false;
        }
        send(comments) {
            if (options.throwOnSend) {
                throw new Error("synthetic renderer failure");
            }
            this.sendCalls.push(comments);
            this.runline.push(...comments);
        }
        setBounds() {}
    }

    class FakeWorker {
        constructor(url) {
            if (options.disableWorker) {
                throw new Error("Worker unavailable");
            }
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            workers.push(this);
        }

        postMessage(message) { this.lastMessage = message; }
        terminate() { this.terminated = true; }
        emit(data) {
            if (this.onmessage) this.onmessage({ data });
        }
    }

    const document = {
        hidden: false,
        getElementById() { return { offsetWidth: 1920 }; },
        addEventListener(name, handler) {
            if (name === "visibilitychange") {
                visibilityHandler = handler;
            }
        }
    };
    let visibilityHandler = null;
    const context = {
        console,
        setTimeout,
        clearTimeout,
        document,
        window: { innerWidth: 1920, BiliDanmakuParser: parser, addEventListener() {} },
        CommentManager: FakeCommentManager,
        Worker: FakeWorker,
        BiliDanmakuParser: null,
        iina: {
            onMessage(name, handler) { handlers[name] = handler; },
            postMessage(name, data) { outgoing.push({ name, data }); }
        }
    };
    context.CommentProvider = function () { providerCreated += 1; };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, "..", "overlay", "danmaku.js"), "utf8"
    ), context);

    return {
        send(name, data) { handlers[name](data); },
        outgoing,
        workers,
        document,
        get visibilityHandler() { return visibilityHandler; },
        get manager() { return manager; },
        get providerCreated() { return providerCreated; }
    };
}

test("overlay accepts comment batches without rebuilding a provider", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 3,
        title: "Demo",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 3,
        comments: [{ stime: 0, mode: 1, size: 18, text: "first" }],
        parsed: 1,
        accepted: 1,
        skipped: 0
    });
    fixture.send("style", { fontSize: 32 });

    assert.equal(fixture.manager.options.limit, 240);
    assert.equal(fixture.manager.startCalls, 1);
    assert.equal(fixture.manager.timeline.length, 1);
    assert.equal(fixture.manager.timeline[0].size, 32);
    assert.equal(fixture.workers.length, 1);
    assert.equal(fixture.providerCreated, 0);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "available"
    ), true);
});

test("overlay renders due comments progressively from an out-of-order batch", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 10,
        title: "Out of order",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 2
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 10,
        comments: [
            { stime: 3000, mode: 1, size: 18, text: "future" },
            { stime: 1000, mode: 1, size: 18, text: "due" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["due"]);
    fixture.send("time", { time: 4 });
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["due", "future"]);
});

test("overlay skips old history when loading at an advanced playback time", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 21,
        title: "Advanced playback",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 100
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 21,
        comments: [
            { stime: 0, mode: 1, size: 18, text: "old" },
            { stime: 98999, mode: 1, size: 18, text: "too late" },
            { stime: 99200, mode: 1, size: 18, text: "recent" },
            { stime: 101000, mode: 1, size: 18, text: "future" }
        ],
        parsed: 4,
        accepted: 4,
        skipped: 0
    });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["recent"]);
    fixture.send("time", { time: 101 });
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["recent", "future"]);
});

test("overlay falls back to time-sliced parsing when Worker is unavailable", async () => {
    const fixture = loadOverlay({ disableWorker: true });
    fixture.send("stream-start", {
        streamId: 4,
        title: "Fallback",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 4
    });
    fixture.send("stream-chunk", {
        streamId: 4,
        chunk: '<d p="5,1,25,1,1,0,h,3">three</d>' +
            '<d p="3,1,25,1,1,0,h,1">one</d>' +
            '<d p="4,1,25,1,1,0,h,2">two</d>'
    });
    fixture.send("stream-end", { streamId: 4 });
    await wait(10);
    fixture.send("time", { time: 5 });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["one", "two", "three"]);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "complete"
    ), true);
});

test("overlay does not advance CCL while a stream is paused", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 5,
        title: "Paused",
        paused: true,
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 4
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 5,
        comments: [{ stime: 4500, mode: 1, size: 18, text: "paused" }],
        parsed: 1,
        accepted: 1,
        skipped: 0
    });
    fixture.send("time", { time: 5 });

    assert.equal(fixture.manager.stopCalls > 0, true);
    assert.equal(fixture.manager.sendCalls.length, 0);
    fixture.send("pause", { paused: false });
    assert.equal(fixture.manager.sendCalls.length, 1);
});

test("overlay ignores batches from a superseded stream", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 6,
        title: "Old",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    const oldWorker = fixture.workers[0];
    fixture.send("stream-start", {
        streamId: 7,
        title: "New",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    oldWorker.emit({
        type: "comments", streamId: 6,
        comments: [{ stime: 0, mode: 1, size: 18, text: "old" }],
        parsed: 1, accepted: 1, skipped: 0
    });
    fixture.workers[1].emit({
        type: "comments", streamId: 7,
        comments: [{ stime: 0, mode: 1, size: 18, text: "new" }],
        parsed: 1, accepted: 1, skipped: 0
    });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.timeline.map((comment) => comment.text)
    )), ["new"]);
});

test("overlay clears and seeks on a large backward or forward jump", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 8,
        title: "Seek",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    const clearBeforeJump = fixture.manager.clearCalls;
    fixture.send("time", { time: 8 });

    assert.equal(fixture.manager.clearCalls > clearBeforeJump, true);
});

test("overlay reports an empty stream without marking it available", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 9,
        title: "Empty",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.workers[0].emit({
        type: "complete", streamId: 9, parsed: 2, accepted: 0, skipped: 2
    });

    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "empty"
    ), true);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "available"
    ), false);
});

test("overlay clears visible and queued comments after a parser error", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 13,
        title: "Error",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 13,
        comments: [
            { stime: 0, mode: 1, size: 18, text: "visible" },
            { stime: 10000, mode: 1, size: 18, text: "queued" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });
    const sentBeforeError = fixture.manager.sendCalls.length;
    fixture.workers[0].emit({
        type: "error", streamId: 13, message: "bad XML"
    });
    fixture.send("time", { time: 20 });

    assert.equal(fixture.manager.clearCalls > 0, true);
    assert.equal(fixture.manager.timeline.length, 0);
    assert.equal(fixture.manager.runline.length, 0);
    assert.equal(fixture.manager.sendCalls.length, sentBeforeError);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "error"
    ), true);
});

test("overlay caps due comments at the active CCL limit", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 14,
        title: "Limit",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 14,
        comments: Array.from({ length: 300 }, (_, index) => ({
            stime: 0, mode: 1, size: 18, text: String(index)
        })),
        parsed: 300,
        accepted: 300,
        skipped: 0
    });

    const sent = fixture.manager.sendCalls.flatMap((batch) => batch);
    assert.equal(sent.length, 240);
    assert.equal(fixture.manager.runline.length, 240);
});

test("overlay replays received comments after a backward seek", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 15,
        title: "Replay",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 15,
        comments: [
            { stime: 0, mode: 1, size: 18, text: "first" },
            { stime: 5000, mode: 1, size: 18, text: "second" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });
    fixture.send("time", { time: 5 });
    fixture.send("time", { time: 0 });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["first", "second", "first"]);
});

test("overlay applies top and bottom filters before sending due comments", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 16,
        title: "Filters",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.send("filter", { showTop: false, showBottom: true });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 16,
        comments: [
            { stime: 0, mode: 5, size: 18, text: "top" },
            { stime: 0, mode: 4, size: 18, text: "bottom" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["bottom"]);
});

test("overlay converts renderer exceptions into a stream error", () => {
    const fixture = loadOverlay({ throwOnSend: true });
    fixture.send("stream-start", {
        streamId: 17,
        title: "Renderer error",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 17,
        comments: [{ stime: 0, mode: 1, size: 18, text: "boom" }],
        parsed: 1,
        accepted: 1,
        skipped: 0
    });

    assert.equal(fixture.workers[0].terminated, true);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "overlay-error" && message.data.streamId === 17
    ), true);
    assert.equal(fixture.manager.timeline.length, 0);
});

test("overlay converts validation exceptions into a stream error", () => {
    const fixture = loadOverlay({ throwOnValidate: true });
    fixture.send("stream-start", {
        streamId: 19,
        title: "Validation error",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 19,
        comments: [{ stime: 0, mode: 1, size: 18, text: "boom" }],
        parsed: 1,
        accepted: 1,
        skipped: 0
    });

    assert.equal(fixture.workers[0].terminated, true);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "overlay-error" && message.data.streamId === 19
    ), true);
});

test("overlay retains due comments while the page is hidden", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 20,
        title: "Hidden",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    fixture.document.hidden = true;
    fixture.visibilityHandler();
    fixture.workers[0].emit({
        type: "comments",
        streamId: 20,
        comments: [{ stime: 0, mode: 1, size: 18, text: "hidden" }],
        parsed: 1,
        accepted: 1,
        skipped: 0
    });
    assert.equal(fixture.manager.sendCalls.length, 0);

    fixture.document.hidden = false;
    fixture.visibilityHandler();
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["hidden"]);
});
