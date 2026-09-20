const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../overlay/danmaku-parser.js");

function wait(milliseconds = 0) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function playbackState(time, patch) {
    return Object.assign({
        time,
        paused: false,
        rate: 1,
        seeking: false,
        revision: 0
    }, patch);
}

function loadOverlay(options = {}) {
    const outgoing = [];
    const handlers = {};
    const workers = [];
    const cssProperties = {};
    let manager = null;
    let providerCreated = 0;
    const animationFrames = [];
    const requestAnimationFrame = (callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
    };

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
            this.boundsCalls = 0;
            this.timerValues = [];
            this.animations = [];
            manager = this;
        }

        init() {}
        start() { this.startCalls += 1; this._accepting = true; }
        stop() { this.stopCalls += 1; this._accepting = false; }
        clear() { this.clearCalls += 1; this.runline = []; }
        seek() { this.seekCalls += 1; }
        time() { this.timeCalls += 1; }
        onTimerEvent(timePassed) { this.timerValues.push(timePassed); }
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
            const rendered = comments.map((data) => {
                const comment = Object.assign({}, data);
                const animations = [];
                comment.dom = { style: {}, getAnimations() { return animations; } };
                comment.fontWrites = 0;
                // Mirror CCL CoreComment: the color setter writes dom.style.color
                // from XML data and must stay untouched by font/stroke settings.
                Object.defineProperty(comment, "color", {
                    get() { return this._color; },
                    set(value) {
                        this._color = value;
                        this.dom.style.color =
                            "#" + (Number(value) >>> 0).toString(16).padStart(6, "0");
                    }
                });
                if (data.color !== undefined) {
                    comment.color = data.color;
                }
                Object.defineProperty(comment, "font", {
                    get() { return this.dom.style.fontFamily; },
                    set(value) {
                        this.fontWrites += 1;
                        this.dom.style.fontFamily = value;
                    }
                });
                comment.font = data.font;
                requestAnimationFrame(() => {
                    const animation = { playbackRate: 1 };
                    animations.push(animation);
                    this.animations.push(animation);
                });
                return comment;
            });
            this.sendCalls.push(comments);
            this.runline.push(...rendered);
        }
        setBounds() { this.boundsCalls += 1; }
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
        documentElement: {
            style: { setProperty(name, value) { cssProperties[name] = value; } }
        },
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
        window: {
            innerWidth: 1920,
            BiliDanmakuParser: parser,
            requestAnimationFrame,
            addEventListener() {}
        },
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
        cssProperties,
        document,
        flushAnimationFrames() {
            while (animationFrames.length > 0) {
                animationFrames.shift()();
            }
        },
        get visibilityHandler() { return visibilityHandler; },
        get manager() { return manager; },
        get providerCreated() { return providerCreated; }
    };
}

const FONT_PRESETS = {
    system: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    sans: 'Arial, "Helvetica Neue", sans-serif',
    serif: 'Songti SC, "STSong", serif',
    rounded: '"Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", sans-serif',
    mono: 'Menlo, Monaco, monospace'
};

for (const [preset, font] of Object.entries(FONT_PRESETS)) {
    test(`overlay applies ${preset} to initial and later comment batches`, () => {
        const fixture = loadOverlay();
        fixture.send("stream-start", { streamId: 60, settings: { fontFamily: preset } });
        for (let batch = 0; batch < 2; batch += 1) {
            fixture.workers[0].emit({
                type: "comments", streamId: 60,
                comments: [{ stime: 0, mode: 1, text: String(batch), color: 0xff0000 }]
            });
        }
        assert.equal(fixture.manager.timeline.length, 2);
        for (const comment of [...fixture.manager.timeline, ...fixture.manager.runline]) {
            assert.equal(comment.font, font);
            assert.equal(comment.color, 0xff0000);
        }
    });
}

test("live fonts update visible, queued and replayed history without resetting parsing", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 61, initialTime: 5 });
    const manager = fixture.manager;
    const worker = fixture.workers[0];
    worker.emit({
        type: "comments", streamId: 61,
        comments: [0, 5000, 7000].map((stime) => ({
            stime, mode: 1, text: String(stime), color: 0x00ff00
        }))
    });
    assert.equal(manager.runline[0].font, FONT_PRESETS.system);
    const visible = manager.runline[0];
    const clearCalls = manager.clearCalls;
    const boundsCalls = manager.boundsCalls;
    const lastMessage = worker.lastMessage;
    for (const [preset, font] of Object.entries(FONT_PRESETS)) {
        fixture.send("style", { fontFamily: preset });
        assert.equal(visible.dom.style.fontFamily, font);
        manager.timeline.forEach((comment) => assert.equal(comment.font, font));
        const writes = visible.fontWrites;
        fixture.send("style", { fontFamily: preset });
        assert.equal(visible.fontWrites, writes, "unchanged fonts skip the setter");
    }
    worker.emit({
        type: "comments", streamId: 61,
        comments: [{ stime: 5000, mode: 1, text: "later", color: 0xff0000 }]
    });
    assert.equal(manager.runline.at(-1).font, FONT_PRESETS.mono);
    assert.equal(manager.runline.at(-1).color, 0xff0000);
    assert.equal(fixture.manager, manager);
    assert.equal(manager.runline[0], visible);
    assert.equal(manager.clearCalls, clearCalls);
    assert.equal(manager.boundsCalls, boundsCalls);
    assert.equal(fixture.workers.length, 1);
    assert.equal(worker.terminated, undefined);
    assert.equal(worker.lastMessage, lastMessage);
    assert.equal(fixture.providerCreated, 0);
    fixture.send("playback-state", playbackState(7));
    assert.equal(manager.runline.at(-1).font, FONT_PRESETS.mono);
    fixture.send("playback-state", playbackState(0, { revision: 1 }));
    assert.equal(manager.runline[0].text, "0");
    assert.equal(manager.runline[0].font, FONT_PRESETS.mono);
    assert.equal(manager.runline[0].color, 0x00ff00);
});

test("overlay resolves free-form font families to a quoted literal plus system fallback", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 66, settings: { fontFamily: "PingFang SC" } });
    fixture.workers[0].emit({
        type: "comments", streamId: 66,
        comments: [{ stime: 0, mode: 1, text: "custom" }]
    });
    const visible = fixture.manager.runline[0];
    const expected = "'PingFang SC', " + FONT_PRESETS.system;
    assert.equal(visible.dom.style.fontFamily, expected);
    assert.ok(visible.dom.style.fontFamily.indexOf("'PingFang SC'") >= 0);
    assert.ok(visible.dom.style.fontFamily.indexOf(FONT_PRESETS.system) >= 0);
    fixture.send("style", { fontFamily: "Noto Sans SC" });
    assert.equal(visible.dom.style.fontFamily, "'Noto Sans SC', " + FONT_PRESETS.system);
});

test("overlay sanitizes font families: unsafe strings fall back, safe literals are quoted", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 62, settings: { fontFamily: "mono" } });
    fixture.workers[0].emit({
        type: "comments", streamId: 62, comments: [{ stime: 0, mode: 1, text: "font" }]
    });
    const visible = fixture.manager.runline[0];
    for (const fontFamily of [
        "url(https://example.com/font)",
        'evil"; color: red; "',
        "family{}",
        "a,b;c",
        "x".repeat(61),
        "",
        null,
        42
    ]) {
        fixture.send("style", { fontFamily });
        assert.equal(visible.font, FONT_PRESETS.system);
    }
    // Safe non-preset strings become quoted free-form literals with a system fallback.
    for (const fontFamily of ["toString", "__proto__", "PingFang SC"]) {
        fixture.send("style", { fontFamily });
        assert.equal(visible.font, "'" + fontFamily + "', " + FONT_PRESETS.system);
    }
});

test("stroke defaults and half-pixel updates do not resize or reset the renderer", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 63 });
    assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "1px");
    const manager = fixture.manager;
    const worker = fixture.workers[0];
    const clearCalls = manager.clearCalls;
    const boundsCalls = manager.boundsCalls;
    const lastMessage = worker.lastMessage;
    for (const strokeWidth of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
        fixture.send("style", { strokeWidth });
        assert.equal(fixture.cssProperties["--danmaku-stroke-width"], `${strokeWidth}px`);
    }
    assert.equal(fixture.manager, manager);
    assert.equal(manager.clearCalls, clearCalls);
    assert.equal(manager.boundsCalls, boundsCalls);
    assert.equal(fixture.workers.length, 1);
    assert.equal(worker.terminated, undefined);
    assert.equal(worker.lastMessage, lastMessage);
    fixture.send("stream-start", { streamId: 64, settings: { strokeWidth: 0.5 } });
    assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "0.5px");
});

test("stroke color sanitization mirrors stroke width and applies on stream start", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 67 });
    assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "1px");
    assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#000000");
    fixture.send("style", { strokeColor: "#ff8800" });
    assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#ff8800");
    fixture.send("style", { strokeColor: "#00FF00" });
    assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#00FF00");
    for (const strokeColor of ["#fff", "red", "javascript:", "#ff88", "#ggg000", 123, null]) {
        fixture.send("style", { strokeColor });
        assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#000000");
    }
    fixture.send("stream-start", { streamId: 68, settings: { strokeColor: "#123abc" } });
    assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#123abc");
});

test("user font and stroke settings never overwrite data-driven comment colors", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", { streamId: 69 });
    fixture.workers[0].emit({
        type: "comments", streamId: 69,
        comments: [{ stime: 0, mode: 1, text: "colored", color: 0xff0000 }]
    });
    const visible = fixture.manager.runline[0];
    assert.equal(visible.dom.style.color, "#ff0000");
    fixture.send("style", { fontFamily: "serif", strokeColor: "#00ff00", strokeWidth: 2 });
    assert.equal(visible.dom.style.color, "#ff0000");
    assert.equal(visible.font, FONT_PRESETS.serif);
    assert.equal(fixture.cssProperties["--danmaku-stroke-color"], "#00ff00");
    assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "2px");
});

test("overlay CSS stroke override targets base comments only and sets width and color vars", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "overlay", "danmaku.html"), "utf8");
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.ok(html.indexOf("vendor/ccl.min.css") < html.indexOf("<style>"));
    const rule = css.match(/([^{}]+)\{\s*-webkit-text-stroke-width:\s*var\(--danmaku-stroke-width,\s*1px\);\s*-webkit-text-stroke-color:\s*var\(--danmaku-stroke-color,\s*#000\);\s*\}/);
    assert.ok(rule, "project override sets both stroke vars for base comments");
    assert.match(rule[1], /\.abp \.container \.cmt(?:\s*,|\s*$)/);
    assert.ok(!/\.reverse-shadow/.test(rule[1]), "vendor reverse-shadow class keeps its own stroke");
    assert.ok(!/\.no-shadow/.test(rule[1]), "vendor no-shadow class keeps its own stroke");
    const vendorCss = fs.readFileSync(path.join(__dirname, "..", "overlay", "vendor", "ccl.min.css"), "utf8");
    assert.ok(vendorCss.indexOf(".cmt.reverse-shadow") >= 0 &&
        vendorCss.indexOf("-webkit-text-stroke:1px #fff") >= 0,
        "vendor css defines reverse-shadow white stroke (data style source)");
    assert.ok(vendorCss.indexOf(".cmt.no-shadow") >= 0 &&
        vendorCss.indexOf("-webkit-text-stroke:0") >= 0,
        "vendor css defines no-shadow zero stroke (data style source)");
});

test("overlay keeps stroke values within range and partial styles preserve typography", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 65, settings: { fontFamily: "serif", strokeWidth: 2 }
    });
    for (const [strokeWidth, expected] of [[-1, 0], [4, 3], [1.2, 1], [1.7, 1.5]]) {
        fixture.send("style", { strokeWidth });
        assert.equal(fixture.cssProperties["--danmaku-stroke-width"], `${expected}px`);
    }
    for (const strokeWidth of [NaN, Infinity, "invalid"]) {
        fixture.send("style", { strokeWidth });
        assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "1.5px");
    }
    fixture.send("style", { speed: 700, fontSize: 30 });
    fixture.workers[0].emit({
        type: "comments", streamId: 65, comments: [{ stime: 0, mode: 1, text: "partial" }]
    });
    assert.equal(fixture.manager.runline[0].font, FONT_PRESETS.serif);
    assert.equal(fixture.cssProperties["--danmaku-stroke-width"], "1.5px");
});

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
    fixture.send("playback-state", playbackState(4));
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
    fixture.send("playback-state", playbackState(101));
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
    fixture.send("playback-state", playbackState(5));

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["one", "two", "three"]);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "complete"
    ), true);
});

test("overlay forwards worker chunk acknowledgements to main", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 22,
        title: "Worker acknowledgement",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.send("stream-chunk", {
        streamId: 22,
        chunkId: 5,
        chunk: '<d p="1,1,25,1,1,0,h,1">ready</d>'
    });

    const forwarded = fixture.workers[0].lastMessage;
    assert.equal(forwarded.type, "chunk");
    assert.equal(forwarded.chunkId, 5);
    fixture.workers[0].emit({
        type: "chunk-consumed",
        streamId: forwarded.streamId,
        chunkId: forwarded.chunkId
    });

    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-chunk-consumed" && message.data.streamId === 22 &&
        message.data.chunkId === 5
    ), true);
});

test("fallback acknowledges a main chunk after all slices are parsed", async () => {
    const fixture = loadOverlay({ disableWorker: true });
    fixture.send("stream-start", {
        streamId: 23,
        title: "Fallback acknowledgement",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.send("stream-chunk", {
        streamId: 23,
        chunkId: 6,
        chunk: " ".repeat(16 * 1024) + '<d p="1,1,25,1,1,0,h,1">ready</d>'
    });

    await wait(20);
    assert.equal(fixture.outgoing.filter((message) =>
        message.name === "stream-chunk-consumed" && message.data.streamId === 23 &&
        message.data.chunkId === 6
    ).length, 1);
});

test("overlay falls back when the worker fails before parsing anything", async () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 30,
        title: "Worker failure",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.send("stream-chunk", {
        streamId: 30,
        chunkId: 0,
        chunk: '<d p="2.5,1,25,1,1,0,h,1">alpha</d>'
    });
    fixture.workers[0].onerror({ message: "worker script failed" });
    await wait(20);
    fixture.send("stream-chunk", {
        streamId: 30,
        chunkId: 1,
        chunk: '<d p="2.8,1,25,1,1,0,h,2">beta</d>'
    });
    fixture.send("stream-end", { streamId: 30 });
    await wait(20);
    fixture.send("playback-state", playbackState(3));

    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.sendCalls.flatMap((batch) => batch.map((comment) => comment.text))
    )), ["alpha", "beta"]);
    assert.deepEqual(fixture.outgoing
        .filter((message) => message.name === "stream-chunk-consumed" && message.data.streamId === 30)
        .map((message) => message.data.chunkId), [0, 1]);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "error"
    ), false);
});

test("completes an empty stream when the worker dies after end was forwarded", async () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 40,
        title: "Empty worker death",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.send("stream-end", { streamId: 40 });
    fixture.workers[0].onerror({ message: "worker script failed" });
    await wait(20);

    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "empty"
    ), true);
    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "error"
    ), false);
});

test("reports a fatal error when the worker fails after producing output", async () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 41,
        title: "Worker crash",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 0
    });
    fixture.workers[0].emit({
        type: "progress", streamId: 41, parsed: 1, accepted: 0, skipped: 0
    });
    fixture.workers[0].onerror({ message: "worker crashed" });
    await wait(20);

    assert.equal(fixture.outgoing.some((message) =>
        message.name === "stream-state" && message.data.phase === "error"
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
    fixture.send("playback-state", playbackState(5, { paused: true }));

    assert.equal(fixture.manager.stopCalls > 0, true);
    assert.equal(fixture.manager.sendCalls.length, 0);
    fixture.send("playback-state", playbackState(5));
    assert.equal(fixture.manager.sendCalls.length, 1);
});

test("overlay follows playback-state revisions and keeps CCL plus DOM animations in sync", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 50,
        title: "Playback state",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        playbackState: { time: 5, paused: false, rate: 1, seeking: false, revision: 0 }
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 50,
        comments: [
            { stime: 1000, mode: 1, size: 18, text: "old" },
            { stime: 5000, mode: 1, size: 18, text: "visible" },
            { stime: 7000, mode: 4, size: 18, text: "target" }
        ],
        parsed: 3,
        accepted: 3,
        skipped: 0
    });
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), ["visible"]);

    const clearBeforeSeeking = fixture.manager.clearCalls;
    fixture.send("playback-state", {
        time: 6, paused: false, rate: 2, seeking: true, revision: 0
    });
    fixture.send("playback-state", {
        time: 7, paused: false, rate: 2, seeking: true, revision: 0
    });
    assert.equal(fixture.manager.stopCalls > 0, true);
    assert.equal(fixture.manager.clearCalls, clearBeforeSeeking);

    fixture.send("playback-state", {
        time: 7, paused: false, rate: 2, seeking: false, revision: 1
    });
    fixture.flushAnimationFrames();
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), ["target"]);
    assert.equal(fixture.manager.clearCalls, clearBeforeSeeking + 1);
    fixture.manager.onTimerEvent(10);
    assert.equal(fixture.manager.timerValues.at(-1), 20);
    assert.equal(fixture.manager.animations.at(-1).playbackRate, 2);

    fixture.workers[0].emit({
        type: "comments",
        streamId: 50,
        comments: [
            { stime: 1000, mode: 1, size: 18, text: "late batch" },
            { stime: 7000, mode: 5, size: 18, text: "new target" }
        ],
        parsed: 5,
        accepted: 5,
        skipped: 0
    });
    fixture.flushAnimationFrames();
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), ["target", "new target"]);
    assert.equal(fixture.manager.animations.at(-1).playbackRate, 2);

    fixture.send("playback-state", {
        time: 7, paused: true, rate: 0.5, seeking: false, revision: 1
    });
    fixture.send("playback-state", {
        time: 7, paused: false, rate: 0.5, seeking: false, revision: 1
    });
    fixture.manager.onTimerEvent(10);
    assert.equal(fixture.manager.timerValues.at(-1), 5);
    assert.equal(fixture.manager.animations.at(-1).playbackRate, 0.5);
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

test("overlay clears and seeks when a seeking event is missed", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 8,
        title: "Seek",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        initialTime: 1
    });
    const clearBeforeJump = fixture.manager.clearCalls;
    fixture.send("playback-state", playbackState(8));

    assert.equal(fixture.manager.clearCalls > clearBeforeJump, true);
});

test("overlay rebuilds during a paused seek before it resumes", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 51,
        title: "Paused seek",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        playbackState: { time: 5, paused: false, rate: 1, seeking: false, revision: 0 }
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 51,
        comments: [
            { stime: 5000, mode: 1, size: 18, text: "old visible" },
            { stime: 10000, mode: 1, size: 18, text: "final target" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });
    fixture.send("playback-state", playbackState(5, { paused: true }));
    const clearBeforeSeek = fixture.manager.clearCalls;
    fixture.send("playback-state", playbackState(10, { paused: true, revision: 1 }));

    assert.equal(fixture.manager.clearCalls, clearBeforeSeek + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), []);

    fixture.send("playback-state", playbackState(10, { revision: 1 }));
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), ["final target"]);
});

test("overlay ignores stale playback revisions", () => {
    const fixture = loadOverlay();
    fixture.send("stream-start", {
        streamId: 52,
        title: "Stale revision",
        settings: { fontSize: 25, speed: 680, showTop: true, showBottom: true },
        playbackState: { time: 5, paused: false, rate: 1, seeking: false, revision: 0 }
    });
    fixture.workers[0].emit({
        type: "comments",
        streamId: 52,
        comments: [
            { stime: 5000, mode: 1, size: 18, text: "old" },
            { stime: 7000, mode: 1, size: 18, text: "current" }
        ],
        parsed: 2,
        accepted: 2,
        skipped: 0
    });
    fixture.send("playback-state", playbackState(7, { revision: 1 }));
    fixture.flushAnimationFrames();
    const clearAfterRevision = fixture.manager.clearCalls;
    fixture.send("playback-state", playbackState(5, { paused: true, rate: 0.5 }));

    assert.equal(fixture.manager.clearCalls, clearAfterRevision);
    assert.deepEqual(JSON.parse(JSON.stringify(
        fixture.manager.runline.map((comment) => comment.text)
    )), ["current"]);
    assert.equal(fixture.manager.animations.at(-1).playbackRate, 1);
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
    fixture.send("playback-state", playbackState(20));

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
    fixture.send("playback-state", playbackState(5));
    fixture.send("playback-state", playbackState(0, { revision: 1 }));

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
