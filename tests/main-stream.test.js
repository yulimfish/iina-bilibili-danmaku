const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function wait(milliseconds = 0) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadMainFixture(options = {}) {
    const eventHandlers = {};
    const sidebarHandlers = {};
    const overlayHandlers = {};
    const overlayMessages = [];
    const sidebarMessages = [];
    const clock = { now: 0 };
    const defaultXml = '<i><d p="1,1,25,1,1,0,h,1">' +
        "x".repeat(128 * 1024 + 20) + "</d></i>";
    const xmls = options.xmls || [defaultXml];
    let videoRequestCount = 0;
    let danmakuRequestCount = 0;

    const sidebar = {
        loadFile() {},
        onMessage(name, handler) { sidebarHandlers[name] = handler; },
        postMessage(name, data) { sidebarMessages.push({ name, data }); },
        show() {},
        hide() {}
    };
    const overlay = {
        loadFile() {
            setTimeout(() => {
                if (eventHandlers["iina.plugin-overlay-loaded"]) {
                    eventHandlers["iina.plugin-overlay-loaded"]();
                }
            }, 0);
        },
        onMessage(name, handler) { overlayHandlers[name] = handler; },
        postMessage(name, data) {
            overlayMessages.push({ name, data });
            if (name === "ping" && overlayHandlers["overlay-ready"]) {
                overlayHandlers["overlay-ready"]({});
            }
        },
        setClickable() {},
        show() {},
        hide() {},
        setOpacity() {}
    };
    const http = {
        async get(url) {
            if (url.includes("/x/web-interface/view")) {
                videoRequestCount += 1;
                return {
                    statusCode: 200,
                    text: JSON.stringify({ code: 0, data: {
                        title: "Demo " + videoRequestCount,
                        pages: Array.from({ length: options.pageCount || 1 }, (_, index) => ({
                            page: index + 1, part: "", cid: videoRequestCount + index
                        }))
                    } })
                };
            }
            if (url.includes("/x/v1/dm/list.so")) {
                const index = Math.min(danmakuRequestCount, xmls.length - 1);
                danmakuRequestCount += 1;
                return { statusCode: 200, text: xmls[index] };
            }
            throw new Error("unexpected URL: " + url);
        }
    };
    const context = {
        console,
        Date: { now: () => clock.now },
        setTimeout,
        clearTimeout,
        iina: {
            core: { window: { loaded: true }, status: { idle: false } },
            console,
            menu: {
                item() { return { addSubMenuItem() {} }; },
                addItem() {}
            },
            sidebar,
            overlay,
            event: {
                on(name, handler) { eventHandlers[name] = handler; }
            },
            mpv: {},
            http,
            preferences: {
                get() { return options.settings || null; },
                set() {},
                sync() {}
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, "..", "main.js"), "utf8"
    ), context);
    return { eventHandlers, sidebarHandlers, overlayHandlers, overlayMessages, sidebarMessages, clock, xmls };
}

test("main streams bounded chunks and throttles ordinary time updates", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(30);

    assert.equal(fixture.overlayMessages.some((message) => message.name === "load"), false);
    const chunks = fixture.overlayMessages
        .filter((message) => message.name === "stream-chunk")
        .map((message) => message.data.chunk);
    assert.equal(chunks.length > 0, true);
    assert.equal(chunks.every((chunk) => chunk.length <= 128 * 1024), true);
    assert.equal(chunks.join(""), fixture.xmls[0]);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    fixture.overlayHandlers["stream-state"]({
        streamId: stream.data.streamId, phase: "available", parsed: 1, accepted: 1, skipped: 0
    });
    fixture.clock.now = 1000;
    fixture.eventHandlers["mpv.time-pos.changed"](10);
    fixture.eventHandlers["mpv.time-pos.changed"](10.01);
    fixture.eventHandlers["mpv.time-pos.changed"](10.02);
    assert.equal(fixture.overlayMessages.filter((message) => message.name === "time").length, 1);
    fixture.clock.now = 1033;
    fixture.eventHandlers["mpv.time-pos.changed"](10.05);
    assert.equal(fixture.overlayMessages.filter((message) => message.name === "time").length, 2);
});

test("includes the playback offset in the first stream timestamp", async () => {
    const fixture = loadMainFixture({ settings: { offset: 2 } });
    fixture.eventHandlers["mpv.time-pos.changed"](10);
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.initialTime, 12);
});

test("keeps pause state and pending settings when the overlay is not ready", async () => {
    const fixture = loadMainFixture();
    fixture.eventHandlers["mpv.pause.changed"](true);
    const load = fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    fixture.sidebarHandlers["update-settings"]({ patch: { fontSize: 32 } });
    await load;
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.paused, true);
    assert.equal(stream.data.settings.fontSize, 32);
});

test("forwards time and offset changes while a stream is still parsing", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    fixture.clock.now = 1000;
    fixture.eventHandlers["mpv.time-pos.changed"](3);
    assert.equal(fixture.overlayMessages.filter((message) => message.name === "time").length, 1);
    fixture.sidebarHandlers["update-settings"]({ patch: { offset: 2 } });
    const times = fixture.overlayMessages.filter((message) => message.name === "time");
    assert.equal(times[times.length - 1].data.time, 5);
    assert.equal(stream.data.streamId > 0, true);
});

test("forwards progressive parser phases to the sidebar status", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");

    fixture.overlayHandlers["stream-state"]({
        streamId: stream.data.streamId, phase: "parsing", parsed: 12, accepted: 4, skipped: 8
    });
    assert.match(fixture.sidebarMessages.at(-1).data.text, /12/);
    fixture.overlayHandlers["stream-state"]({
        streamId: stream.data.streamId, phase: "progress", parsed: 20, accepted: 8, skipped: 12
    });
    assert.match(fixture.sidebarMessages.at(-1).data.text, /20/);
});

test("clears the current stream as soon as a newer source request starts", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const clearCount = fixture.overlayMessages.filter((message) => message.name === "clear").length;
    const secondLoad = fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });

    assert.equal(fixture.overlayMessages.filter((message) => message.name === "clear").length, clearCount + 1);
    await secondLoad;
});

test("stops the chunk pump after a renderer error", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    const chunkCount = fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === stream.data.streamId
    ).length;

    fixture.overlayHandlers["stream-state"]({
        streamId: stream.data.streamId, phase: "error", parsed: 0, accepted: 0, skipped: 0
    });
    await wait(10);

    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === stream.data.streamId
    ).length, chunkCount);
});

test("stops the chunk pump on a standalone overlay error", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    const chunkCount = fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === stream.data.streamId
    ).length;

    fixture.overlayHandlers["overlay-error"]({
        streamId: stream.data.streamId, message: "standalone failure"
    });
    await wait(10);

    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === stream.data.streamId
    ).length, chunkCount);
});

test("stops playback IPC after an empty stream completes", async () => {
    const fixture = loadMainFixture({ xmls: ["<i></i>"] });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    fixture.overlayHandlers["stream-state"]({
        streamId: stream.data.streamId, phase: "empty", parsed: 0, accepted: 0, skipped: 0
    });
    const before = fixture.overlayMessages.length;
    fixture.eventHandlers["mpv.time-pos.changed"](4);
    fixture.eventHandlers["mpv.pause.changed"](true);

    assert.equal(fixture.overlayMessages.length, before);
});

test("cancels scheduled chunks when a newer source starts", async () => {
    const firstXml = '<i><d p="1,1,25,1,1,0,a,1">' +
        "A".repeat(128 * 1024 + 20) + "</d></i>";
    const secondXml = '<i><d p="1,1,25,1,1,0,b,2">' +
        "B".repeat(128 * 1024 + 20) + "</d></i>";
    const fixture = loadMainFixture({ xmls: [firstXml, secondXml] });

    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const firstStream = fixture.overlayMessages.find((message) =>
        message.name === "stream-start").data.streamId;
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(20);

    const firstChunks = fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === firstStream);
    assert.equal(firstChunks.length, 1);
    assert.equal(fixture.overlayMessages.some((message) =>
        message.name === "stream-end" && message.data.streamId === firstStream
    ), false);
});

test("cancels the current stream before a bangumi search starts", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const clearCount = fixture.overlayMessages.filter((message) => message.name === "clear").length;
    await fixture.sidebarHandlers["search-bangumi"]({ keyword: "demo" });

    assert.equal(fixture.overlayMessages.filter((message) => message.name === "clear").length, clearCount + 1);
});

test("cancels the current stream before a different part starts", async () => {
    const fixture = loadMainFixture({ pageCount: 2 });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const clearCount = fixture.overlayMessages.filter((message) => message.name === "clear").length;
    await fixture.sidebarHandlers["select-part"]({ index: 1 });

    assert.equal(fixture.overlayMessages.filter((message) => message.name === "clear").length, clearCount + 1);
});
