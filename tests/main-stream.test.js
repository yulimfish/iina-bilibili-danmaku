const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function wait(milliseconds = 0) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
    let resolve;
    const promise = new Promise((next) => { resolve = next; });
    return { promise, resolve };
}

function searchResponse(title, seasonId = 1) {
    return {
        statusCode: 200,
        text: JSON.stringify({
            code: 0,
            data: { result: [{ season_id: seasonId, title, pubtime: 0 }] }
        })
    };
}

function loadMainFixture(options = {}) {
    const eventHandlers = {};
    const sidebarHandlers = {};
    const overlayHandlers = {};
    const overlayMessages = [];
    const sidebarMessages = [];
    const osdMessages = [];
    const clock = { now: 0 };
    let setClickableCalls = 0;
    let savedSettings = null;
    let preferenceSyncCalls = 0;
    let mpvPosition = options.mpvPosition === undefined
        ? (options.position === undefined ? 0 : options.position)
        : options.mpvPosition;
    const defaultXml = '<i><d p="1,1,25,1,1,0,h,1">' +
        "x".repeat(128 * 1024 + 20) + "</d></i>";
    const xmls = options.xmls || [defaultXml];
    let videoRequestCount = 0;
    let danmakuRequestCount = 0;

    const sidebar = {
        loadFile() {
            // IINA's sidebar.loadFile clears message listeners registered before it.
            Object.keys(sidebarHandlers).forEach((key) => delete sidebarHandlers[key]);
        },
        onMessage(name, handler) { sidebarHandlers[name] = handler; },
        postMessage(name, data) {
            if (options.sidebarPostMessage) options.sidebarPostMessage(name, data);
            sidebarMessages.push({ name, data });
        },
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
            if (name === "ping" && overlayHandlers["overlay-ready"] &&
                options.manualOverlayReady !== true) {
                overlayHandlers["overlay-ready"]({});
            } else if (name === "stream-chunk" && options.autoAcknowledgeChunks !== false) {
                setTimeout(() => {
                    if (overlayHandlers["stream-chunk-consumed"]) {
                        overlayHandlers["stream-chunk-consumed"]({
                            streamId: data.streamId,
                            chunkId: data.chunkId
                        });
                    }
                }, 0);
            }
        },
        setClickable() { setClickableCalls += 1; },
        show() {},
        hide() {},
        setOpacity() {}
    };
    const http = {
        async get(url, request) {
            if (options.httpGet) {
                const response = options.httpGet(url, request);
                if (response !== undefined) {
                    return await response;
                }
            }
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
    const core = {
        window: { loaded: options.windowLoadedInitially !== false },
        osd(message) { osdMessages.push(message); },
        status: {
            idle: false,
            url: options.statusUrl || "",
            position: options.position === undefined ? 0 : options.position,
            paused: options.paused === true,
            speed: options.speed === undefined ? 1 : options.speed
        }
    };
    const mpv = {
        getNumber(name) {
            return name === "time-pos" ? mpvPosition : NaN;
        },
        getFlag(name) {
            return name === "pause" ? Boolean(core.status.paused) : false;
        },
        getString(name) {
            return name === "filename" ? (options.filename || "") : "";
        }
    };
    const prefsStore = {};
    if (options.settings !== undefined) {
        prefsStore.settings = options.settings;
    }
    if (options.prefs) {
        Object.assign(prefsStore, options.prefs);
    }
    const context = {
        console,
        Date: { now: () => clock.now },
        setTimeout,
        clearTimeout,
        iina: {
            core,
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
            mpv,
            http,
            preferences: {
                get(key) {
                    return Object.prototype.hasOwnProperty.call(prefsStore, key) ? prefsStore[key] : null;
                },
                set(key, value) {
                    prefsStore[key] = value;
                    if (key === "settings") savedSettings = value;
                },
                sync() { preferenceSyncCalls += 1; }
            },
            utils: {
                exec(command, args) {
                    if (options.utilsExec) {
                        return options.utilsExec(command, args);
                    }
                    return Promise.reject(new Error("utils.exec unavailable"));
                }
            }
        }
    };
    if (options.globals) {
        Object.assign(context, options.globals);
    }
    if (options.parseJson) {
        context.JSON = { parse: options.parseJson, stringify: JSON.stringify };
    }
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, "..", "main.js"), "utf8"
    ), context);
    return {
        eventHandlers, sidebarHandlers, overlayHandlers, overlayMessages, sidebarMessages, osdMessages,
        clock, xmls, core: context.iina.core,
        get mpvPosition() { return mpvPosition; },
        set mpvPosition(value) { mpvPosition = value; },
        get setClickableCalls() { return setClickableCalls; },
        get savedSettings() { return savedSettings; },
        get preferenceSyncCalls() { return preferenceSyncCalls; },
        get prefs() { return prefsStore; },
        normalizeMediaTitle: context.normalizeMediaTitle,
        parseMediaFilename: context.parseMediaFilename,
        currentFileContext: context.currentFileContext
    };
}

test("parses local filenames into automatic source matching context", () => {
    const parseMediaFilename = loadMainFixture().parseMediaFilename;
    const cases = [
        {
            filename: "[ANi] 葬送的フリーレン - 12 [1080P][WEB-DL].mp4",
            expected: {
                title: "葬送的フリーレン",
                seasonNumber: null,
                episodeNumber: 12,
                partNumber: null,
                bvid: null,
                kindHint: "bangumi",
                confidence: "high"
            }
        },
        {
            filename: "鬼灭之刃.S02E03.1080p.mkv",
            expected: {
                title: "鬼灭之刃",
                seasonNumber: 2,
                episodeNumber: 3,
                partNumber: null,
                bvid: null,
                kindHint: "bangumi",
                confidence: "high"
            }
        },
        {
            filename: "凡人修仙传 年番 第45集.mp4",
            expected: {
                title: "凡人修仙传 年番",
                seasonNumber: null,
                episodeNumber: 45,
                partNumber: null,
                bvid: null,
                kindHint: "bangumi",
                confidence: "high"
            }
        },
        {
            filename: "纪录片.P03.2160p.mp4",
            expected: {
                title: "纪录片",
                seasonNumber: null,
                episodeNumber: null,
                partNumber: 3,
                bvid: null,
                kindHint: "video",
                confidence: "high"
            }
        },
        {
            filename: "纪录片.Part 04.2160p.mp4",
            expected: {
                title: "纪录片",
                seasonNumber: null,
                episodeNumber: null,
                partNumber: 4,
                bvid: null,
                kindHint: "video",
                confidence: "high"
            }
        },
        {
            filename: "纪录片.分P05.2160p.mp4",
            expected: {
                title: "纪录片",
                seasonNumber: null,
                episodeNumber: null,
                partNumber: 5,
                bvid: null,
                kindHint: "video",
                confidence: "high"
            }
        },
        {
            filename: "Movie.2024.2160p.WEB-DL.mkv",
            expected: {
                title: "Movie.2024",
                seasonNumber: null,
                episodeNumber: null,
                partNumber: null,
                bvid: null,
                kindHint: "unknown",
                confidence: "low"
            }
        },
        {
            filename: "BV1xx411c7mD-P2.mp4",
            expected: {
                title: "BV1xx411c7mD",
                seasonNumber: null,
                episodeNumber: null,
                partNumber: 2,
                bvid: "BV1xx411c7mD",
                kindHint: "video",
                confidence: "high"
            }
        },
        ...["01.mp4", "NCOP.mkv", "OVA.mp4"].map((filename) => ({
            filename,
            expected: {
                seasonNumber: null,
                episodeNumber: null,
                partNumber: null,
                bvid: null,
                kindHint: "unknown",
                confidence: "low"
            }
        }))
    ];

    for (const { filename, expected } of cases) {
        const result = parseMediaFilename(filename);
        assert.equal(result.filename, filename);
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(result[key], value, filename + " " + key);
        }
    }
});

test("current file context prefers mpv filename and safely decodes URL fallback", () => {
    const fromMpv = loadMainFixture({
        filename: "鬼灭之刃.S02E03.mkv"
    }).currentFileContext("file:///tmp/other.mp4");
    assert.equal(fromMpv.filename, "鬼灭之刃.S02E03.mkv");
    assert.equal(fromMpv.seasonNumber, 2);
    assert.equal(fromMpv.episodeNumber, 3);

    const fromUrl = loadMainFixture().currentFileContext(
        "file:///Users/test/%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%B1%E7%81%AB%20-%2012.mkv"
    );
    assert.equal(fromUrl.filename, "葬送的花火 - 12.mkv");
    assert.equal(fromUrl.title, "葬送的花火");
    assert.equal(fromUrl.episodeNumber, 12);

    const fromStatus = loadMainFixture({
        statusUrl: "file:///Users/test/%E9%AC%BC%E7%81%AD%E4%B9%8B%E5%88%83.S02E03.mkv"
    }).currentFileContext();
    assert.equal(fromStatus.filename, "鬼灭之刃.S02E03.mkv");
    assert.equal(fromStatus.seasonNumber, 2);

    const malformedUrl = loadMainFixture().currentFileContext(
        "file:///tmp/Show%ZZ%20-12.mkv"
    );
    assert.equal(malformedUrl.filename, "Show%ZZ -12.mkv");
    assert.equal(malformedUrl.episodeNumber, 12);

    const malformedUtf8Url = loadMainFixture().currentFileContext(
        "file:///tmp/Show%E0%A4%A-%2012.mkv"
    );
    assert.equal(malformedUtf8Url.filename, "Show%E0%A4%A- 12.mkv");
    assert.equal(malformedUtf8Url.episodeNumber, 12);
});

test("prioritizes BV ids and keeps ambiguous numeric titles out of episode matching", () => {
    const parseMediaFilename = loadMainFixture().parseMediaFilename;

    const bvid = parseMediaFilename("BV1xx411c7mD-01.mp4");
    assert.equal(bvid.bvid, "BV1xx411c7mD");
    assert.equal(bvid.episodeNumber, null);
    assert.equal(bvid.seasonNumber, null);
    assert.equal(bvid.kindHint, "video");
    assert.equal(bvid.confidence, "high");

    const technical = parseMediaFilename("Movie.H.264.mkv");
    assert.equal(technical.title, "Movie");
    assert.equal(technical.episodeNumber, null);
    assert.equal(technical.confidence, "low");

    for (const filename of [
        "Movie.5.1.mkv",
        "Movie.720.mkv",
        "Movie.01.02.1080p.mkv",
        "Movie.12.2024.2160p.WEB-DL.mkv"
    ]) {
        const result = parseMediaFilename(filename);
        assert.equal(result.episodeNumber, null, filename);
        assert.equal(result.confidence, "low", filename);
    }

    assert.equal(
        parseMediaFilename("3 Body Problem S01E01.mkv").title,
        "3 Body Problem"
    );
    assert.equal(
        parseMediaFilename("The.100.S01E01.1080p.mkv").title,
        "The.100"
    );
    const titleWithNumber = parseMediaFilename("The 100.mkv");
    assert.equal(titleWithNumber.title, "The 100");
    assert.equal(titleWithNumber.episodeNumber, null);
    assert.equal(titleWithNumber.confidence, "low");

    const trailingEpisode = parseMediaFilename("Show - 12.mkv");
    assert.equal(trailingEpisode.title, "Show");
    assert.equal(trailingEpisode.episodeNumber, 12);
    assert.equal(trailingEpisode.confidence, "high");
});

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
    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").length, 1);
    fixture.clock.now = 1033;
    fixture.eventHandlers["mpv.time-pos.changed"](10.05);
    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").length, 2);
});

test("shows the selected source in OSD after its danmaku loads", async () => {
    const fixture = loadMainFixture({ pageCount: 2 });

    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await fixture.sidebarHandlers["select-part"]({ index: 1 });

    assert.deepEqual(fixture.osdMessages, [
        "已切换到「Demo 1」第 1 P",
        "已切换到「Demo 1」第 2 P"
    ]);
});

test("main waits for each overlay chunk acknowledgement before sending the next", async () => {
    const xml = "x".repeat(128 * 1024 * 2 + 20);
    const fixture = loadMainFixture({ xmls: [xml], autoAcknowledgeChunks: false });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(10);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    const streamChunks = () => fixture.overlayMessages.filter((message) =>
        message.name === "stream-chunk" && message.data.streamId === stream.data.streamId
    );
    assert.equal(streamChunks().length, 1);
    assert.equal(fixture.overlayMessages.some((message) =>
        message.name === "stream-end" && message.data.streamId === stream.data.streamId
    ), false);

    const firstChunkId = streamChunks()[0].data.chunkId;
    assert.equal(firstChunkId, 0);
    fixture.overlayHandlers["stream-chunk-consumed"]({
        streamId: stream.data.streamId, chunkId: firstChunkId
    });
    assert.equal(streamChunks().length, 2);
    fixture.overlayHandlers["stream-chunk-consumed"]({
        streamId: stream.data.streamId, chunkId: firstChunkId
    });
    assert.equal(streamChunks().length, 2);
    const secondChunkId = streamChunks()[1].data.chunkId;
    fixture.overlayHandlers["stream-chunk-consumed"]({
        streamId: stream.data.streamId, chunkId: secondChunkId
    });
    assert.equal(streamChunks().length, 3);
    const thirdChunkId = streamChunks()[2].data.chunkId;
    fixture.overlayHandlers["stream-chunk-consumed"]({
        streamId: stream.data.streamId, chunkId: thirdChunkId
    });
    assert.equal(fixture.overlayMessages.some((message) =>
        message.name === "stream-end" && message.data.streamId === stream.data.streamId
    ), true);
    assert.equal(streamChunks().map((message) => message.data.chunk).join(""), xml);
});

test("touches the overlay view only after it reports ready", async () => {
    const fixture = loadMainFixture({ manualOverlayReady: true });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(10);

    assert.equal(fixture.setClickableCalls, 0);
    fixture.overlayHandlers["overlay-ready"]({});
    assert.equal(fixture.setClickableCalls, 1);
});

test("includes the playback offset in the initial playback state", async () => {
    const fixture = loadMainFixture({ settings: { offset: 2 }, position: 10 });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.playbackState.time, 12);
});

test("keeps pause state and pending settings when the overlay is not ready", async () => {
    const fixture = loadMainFixture({ paused: true });
    fixture.eventHandlers["mpv.pause.changed"](true);
    const load = fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    fixture.sidebarHandlers["update-settings"]({ patch: { fontSize: 32 } });
    await load;
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.playbackState.paused, true);
    assert.equal(stream.data.settings.fontSize, 32);
});

test("increments the playback revision when an offset changes before rendering starts", async () => {
    const fixture = loadMainFixture({ position: 10 });
    fixture.sidebarHandlers["update-settings"]({ patch: { offset: 2 } });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.playbackState.time, 12);
    assert.equal(stream.data.playbackState.revision, 1);
});

test("forwards time and offset changes while a stream is still parsing", async () => {
    const fixture = loadMainFixture();
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    fixture.clock.now = 1000;
    fixture.eventHandlers["mpv.time-pos.changed"](3);
    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").length, 1);
    fixture.sidebarHandlers["update-settings"]({ patch: { offset: 2 } });
    const states = fixture.overlayMessages.filter((message) =>
        message.name === "playback-state");
    assert.equal(states[states.length - 1].data.time, 5);
    assert.equal(stream.data.streamId > 0, true);
});

test("publishes an active playback snapshot and immediate discontinuity states", async () => {
    const fixture = loadMainFixture({
        settings: { offset: 2 }, position: 10, paused: true, speed: 1.5
    });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(5);

    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.deepEqual(JSON.parse(JSON.stringify(stream.data.playbackState)), {
        time: 12, paused: true, rate: 1.5, seeking: false, revision: 0
    });

    fixture.clock.now = 1000;
    fixture.eventHandlers["mpv.time-pos.changed"](10);
    fixture.eventHandlers["mpv.time-pos.changed"](10.01);
    fixture.core.status.speed = 2;
    fixture.eventHandlers["mpv.speed.changed"](2);
    fixture.core.status.paused = false;
    fixture.eventHandlers["mpv.pause.changed"](false);
    fixture.eventHandlers["mpv.seeking.changed"](true);
    fixture.mpvPosition = 20;
    fixture.core.status.position = 20;
    fixture.eventHandlers["mpv.seeking.changed"](false);
    fixture.sidebarHandlers["update-settings"]({ patch: { offset: 3 } });

    const states = fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").map((message) => message.data);
    assert.equal(states.length, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(states.at(-4))), {
        time: 12.01, paused: false, rate: 2, seeking: false, revision: 0
    });
    assert.deepEqual(JSON.parse(JSON.stringify(states.at(-3))), {
        time: 12.01, paused: false, rate: 2, seeking: true, revision: 0
    });
    assert.deepEqual(JSON.parse(JSON.stringify(states.at(-2))), {
        time: 22, paused: false, rate: 2, seeking: false, revision: 1
    });
    assert.deepEqual(JSON.parse(JSON.stringify(states.at(-1))), {
        time: 23, paused: false, rate: 2, seeking: false, revision: 2
    });
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

test("keeps danmaku source handlers alive when the sidebar page loads late", async () => {
    const fixture = loadMainFixture({
        windowLoadedInitially: false,
        httpGet(url) {
            if (!url.includes("/x/web-interface/search/type")) return undefined;
            return searchResponse("Demo");
        }
    });

    fixture.core.window.loaded = true;
    fixture.eventHandlers["iina.window-loaded"]();

    assert.equal(typeof fixture.sidebarHandlers["load-source"], "function");
    assert.equal(typeof fixture.sidebarHandlers["search-bangumi"], "function");
    await fixture.sidebarHandlers["search-bangumi"]({ keyword: "demo" });
    assert.equal(fixture.sidebarMessages.filter((message) => message.name === "seasons").length, 1);
});

test("coalesces repeated pending searches for the same normalized keyword", async () => {
    const response = deferred();
    let searchRequests = 0;
    const fixture = loadMainFixture({
        httpGet(url) {
            if (!url.includes("/x/web-interface/search/type")) return undefined;
            searchRequests += 1;
            return response.promise;
        }
    });

    const first = fixture.sidebarHandlers["search-bangumi"]({ keyword: "demo" });
    const second = fixture.sidebarHandlers["search-bangumi"]({ keyword: "  demo  " });
    assert.equal(searchRequests, 1);
    response.resolve(searchResponse("Demo"));
    await Promise.all([first, second]);
    assert.equal(fixture.sidebarMessages.filter((message) => message.name === "seasons").length, 1);
});

test("drops stale search responses before parsing their JSON", async () => {
    const oldResponse = deferred();
    const latestResponse = deferred();
    let parseCalls = 0;
    const fixture = loadMainFixture({
        parseJson(text) {
            parseCalls += 1;
            return JSON.parse(text);
        },
        httpGet(url, request) {
            if (!url.includes("/x/web-interface/search/type")) return undefined;
            return request.params.keyword === "old" ? oldResponse.promise : latestResponse.promise;
        }
    });

    const oldSearch = fixture.sidebarHandlers["search-bangumi"]({ keyword: "old" });
    const latestSearch = fixture.sidebarHandlers["search-bangumi"]({ keyword: "latest" });
    oldResponse.resolve(searchResponse("Old", 1));
    await oldSearch;
    assert.equal(parseCalls, 0);

    latestResponse.resolve(searchResponse("Latest", 2));
    await latestSearch;
    assert.equal(parseCalls, 1);
    const seasons = fixture.sidebarMessages.filter((message) => message.name === "seasons");
    assert.equal(seasons.length, 1);
    assert.equal(seasons[0].data.seasons[0].title, "Latest");
});

test("releases a coalesced search after its promise rejects", async () => {
    let searchRequests = 0;
    let throwFromErrorMessage = true;
    const fixture = loadMainFixture({
        sidebarPostMessage(name) {
            if (name === "error" && throwFromErrorMessage) {
                throwFromErrorMessage = false;
                throw new Error("sidebar unavailable");
            }
        },
        httpGet(url) {
            if (!url.includes("/x/web-interface/search/type")) return undefined;
            searchRequests += 1;
            if (searchRequests === 1) return Promise.reject(new Error("network failed"));
            return searchResponse("Recovered");
        }
    });

    await assert.rejects(
        fixture.sidebarHandlers["search-bangumi"]({ keyword: "demo" }),
        /sidebar unavailable/
    );
    await fixture.sidebarHandlers["search-bangumi"]({ keyword: "demo" });
    assert.equal(searchRequests, 2);
});

test("cancels the current stream before a different part starts", async () => {
    const fixture = loadMainFixture({ pageCount: 2 });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(0);
    const clearCount = fixture.overlayMessages.filter((message) => message.name === "clear").length;
    await fixture.sidebarHandlers["select-part"]({ index: 1 });

    assert.equal(fixture.overlayMessages.filter((message) => message.name === "clear").length, clearCount + 1);
});

test("loads a direct ep link from a season section instead of the first main episode", async () => {
    let requestedOid = null;
    const fixture = loadMainFixture({
        httpGet(url, request) {
            if (url.includes("/pgc/view/web/season")) {
                return {
                    statusCode: 200,
                    text: JSON.stringify({ code: 0, result: {
                        title: "Demo Season",
                        episodes: [{ id: 1, cid: 101, title: "1", long_title: "Main" }],
                        section: [{ episodes: [
                            { id: 99, cid: 999, title: "SP", long_title: "Special" }
                        ] }]
                    } })
                };
            }
            if (url.includes("/x/v1/dm/list.so")) {
                requestedOid = request.params.oid;
                return { statusCode: 200, text: "<i></i>" };
            }
            return undefined;
        }
    });

    await fixture.sidebarHandlers["load-source"]({
        text: "https://www.bilibili.com/bangumi/play/ep99"
    });

    assert.equal(requestedOid, "999");
    const videos = fixture.sidebarMessages.filter((message) => message.name === "video");
    assert.equal(videos.at(-1).data.current, 1);
});

test("rejects a direct ep link when the requested episode is absent", async () => {
    let danmakuRequests = 0;
    const fixture = loadMainFixture({
        httpGet(url) {
            if (url.includes("/pgc/view/web/season")) {
                return {
                    statusCode: 200,
                    text: JSON.stringify({ code: 0, result: {
                        title: "Demo Season",
                        episodes: [{ id: 1, cid: 101, title: "1", long_title: "Main" }]
                    } })
                };
            }
            if (url.includes("/x/v1/dm/list.so")) {
                danmakuRequests += 1;
            }
            return undefined;
        }
    });

    await fixture.sidebarHandlers["load-source"]({
        text: "https://www.bilibili.com/bangumi/play/ep99"
    });

    assert.equal(danmakuRequests, 0);
    const errors = fixture.sidebarMessages.filter((message) => message.name === "error");
    assert.match(errors.at(-1).data.message, /目标分集/);
});

test("resolves an md link through its season before loading danmaku", async () => {
    let requestedSeasonId = null;
    let requestedOid = null;
    const fixture = loadMainFixture({
        httpGet(url, request) {
            if (url.includes("/pgc/review/user")) {
                return {
                    statusCode: 200,
                    text: JSON.stringify({ code: 0, result: { media: { season_id: 7 } } })
                };
            }
            if (url.includes("/pgc/view/web/season")) {
                requestedSeasonId = request.params.season_id;
                return {
                    statusCode: 200,
                    text: JSON.stringify({ code: 0, result: {
                        title: "Resolved Season",
                        episodes: [{ id: 70, cid: 700, title: "1", long_title: "Pilot" }]
                    } })
                };
            }
            if (url.includes("/x/v1/dm/list.so")) {
                requestedOid = request.params.oid;
                return { statusCode: 200, text: "<i></i>" };
            }
            return undefined;
        }
    });

    await fixture.sidebarHandlers["load-source"]({
        text: "https://www.bilibili.com/bangumi/media/md123"
    });

    assert.equal(requestedSeasonId, "7");
    assert.equal(requestedOid, "700");
});

test("persists a settings patch and returns the merged settings to the sidebar", () => {
    const fixture = loadMainFixture({ settings: { opacity: 80 } });

    fixture.sidebarHandlers["update-settings"]({ patch: { fontSize: 32 } });

    assert.equal(fixture.savedSettings.opacity, 80);
    assert.equal(fixture.savedSettings.fontSize, 32);
    assert.equal(fixture.savedSettings.fontFamily, "system");
    assert.equal(fixture.savedSettings.strokeColor, "#000000");
    // One sync for the startup migration save, one for the patch itself.
    assert.equal(fixture.preferenceSyncCalls, 2);
    const settings = fixture.sidebarMessages.filter((message) => message.name === "settings");
    assert.equal(settings.at(-1).data.settings.fontSize, 32);
});

function currentSettings(fixture) {
    fixture.sidebarHandlers["sidebar-ready"]({});
    const messages = fixture.sidebarMessages.filter((message) => message.name === "settings");
    return JSON.parse(JSON.stringify(messages.at(-1).data.settings));
}

test("upgrades legacy settings with default font, stroke and stroke color", () => {
    const settings = currentSettings(loadMainFixture({ settings: { opacity: 80 } }));
    assert.equal(settings.fontFamily, "system");
    assert.equal(settings.strokeWidth, 1);
    assert.equal(settings.strokeColor, "#000000");
    assert.equal(settings.opacity, 80);
});

test("preserves preset ids, free-form family names and valid stroke colors", () => {
    for (const fontFamily of ["system", "sans", "serif", "rounded", "mono",
        "PingFang SC", "Hiragino Maru Gothic ProN", "toString", "Songti SC"]) {
        const settings = currentSettings(loadMainFixture({ settings: { fontFamily, strokeWidth: 2.5 } }));
        assert.equal(settings.fontFamily, fontFamily);
        assert.equal(settings.strokeWidth, 2.5);
    }
    const trimmed = currentSettings(loadMainFixture({ settings: { fontFamily: "  PingFang SC  " } }));
    assert.equal(trimmed.fontFamily, "PingFang SC");
    for (const strokeColor of ["#FF8800", "#00ff00", "#000000"]) {
        const settings = currentSettings(loadMainFixture({ settings: { strokeColor } }));
        assert.equal(settings.strokeColor, strokeColor);
    }
});

test("normalizes saved settings types, ranges and unknown keys", () => {
    const fixture = loadMainFixture({ settings: {
        enabled: "false", showTop: false, showBottom: 0, fontSize: 100,
        opacity: -5, speed: 5000, offset: -100, fontFamily: "toString",
        strokeColor: "red", strokeWidth: 9, extra: true
    } });
    const settings = currentSettings(fixture);
    assert.deepEqual(settings, {
        enabled: true, showTop: false, showBottom: true, fontSize: 36,
        opacity: 0, speed: 1200, offset: -30, fontFamily: "toString",
        strokeColor: "#000000", strokeWidth: 3
    });
    assert.ok(fixture.savedSettings, "stale stored values trigger migration write-back");
    assert.equal(fixture.savedSettings.fontSize, 36);
    assert.equal(fixture.savedSettings.strokeWidth, 3);
    assert.equal(fixture.savedSettings.strokeColor, "#000000");
    for (const invalid of [null, "2", NaN, Infinity, {}, []]) {
        const normalized = currentSettings(loadMainFixture({ settings: {
            strokeWidth: invalid, fontSize: invalid, opacity: invalid,
            speed: invalid, offset: invalid
        } }));
        assert.equal(normalized.strokeWidth, 1);
        assert.equal(normalized.fontSize, 25);
        assert.equal(normalized.opacity, 100);
        assert.equal(normalized.speed, 680);
        assert.equal(normalized.offset, 0);
    }
    for (const invalid of [null, undefined, 2, NaN, true, {}, [],
        "Arial; color:red", "url(https://x)", "url(X", "bad{}name",
        "a<b", 'q"uote', "back\\slash", "line\nbreak", "apos'trophe",
        "a".repeat(61)]) {
        const normalized = currentSettings(loadMainFixture({ settings: { fontFamily: invalid } }));
        assert.equal(normalized.fontFamily, "system");
    }
    for (const invalid of ["#fff", "red", "FF0000", "#12345g", "#00000000", 123, null]) {
        const normalized = currentSettings(loadMainFixture({ settings: { strokeColor: invalid } }));
        assert.equal(normalized.strokeColor, "#000000");
    }
});

test("normalizes patches before persisting and restoring settings", () => {
    const fixture = loadMainFixture({ settings: { opacity: 80, fontFamily: "mono" } });
    fixture.sidebarHandlers["update-settings"]({ patch: {
        fontFamily: "Arial; color:red", strokeWidth: -1, strokeColor: "blue", extra: true
    } });
    assert.equal(fixture.savedSettings.fontFamily, "system");
    assert.equal(fixture.savedSettings.strokeWidth, 0);
    assert.equal(fixture.savedSettings.strokeColor, "#000000");
    assert.equal(fixture.savedSettings.opacity, 80);
    assert.equal("extra" in fixture.savedSettings, false);
    fixture.sidebarHandlers["update-settings"]({ patch: {
        fontFamily: "PingFang SC", strokeWidth: 1.7, strokeColor: "#00AAFF"
    } });
    assert.equal(fixture.savedSettings.fontFamily, "PingFang SC");
    assert.equal(fixture.savedSettings.strokeWidth, 1.5);
    assert.equal(fixture.savedSettings.strokeColor, "#00AAFF");
    // Startup migration + two patch saves.
    assert.equal(fixture.preferenceSyncCalls, 3);
    assert.deepEqual(currentSettings(loadMainFixture({ settings: fixture.savedSettings })), currentSettings(fixture));
});

test("sends current font and stroke in pending streams and live style messages", async () => {
    const fixture = loadMainFixture({ manualOverlayReady: true });
    await fixture.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await wait(5);
    fixture.sidebarHandlers["update-settings"]({ patch: {
        fontFamily: "rounded", strokeWidth: 2, strokeColor: "#00ff00"
    } });
    fixture.overlayHandlers["overlay-ready"]({});
    const stream = fixture.overlayMessages.find((message) => message.name === "stream-start");
    assert.equal(stream.data.settings.fontFamily, "rounded");
    assert.equal(stream.data.settings.strokeWidth, 2);
    assert.equal(stream.data.settings.strokeColor, "#00ff00");
    for (const patch of [{ fontFamily: "mono" }, { strokeWidth: 0.5 }, { fontSize: 30 },
        { speed: 800 }, { strokeColor: "#FF8800" }]) {
        const before = fixture.overlayMessages.length;
        fixture.sidebarHandlers["update-settings"]({ patch });
        const messages = fixture.overlayMessages.slice(before);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].name, "style");
        const settings = currentSettings(fixture);
        assert.deepEqual(JSON.parse(JSON.stringify(messages[0].data)), {
            speed: settings.speed, fontSize: settings.fontSize,
            fontFamily: settings.fontFamily, strokeWidth: settings.strokeWidth,
            strokeColor: settings.strokeColor,
            showTop: settings.showTop, showBottom: settings.showBottom
        });
    }
    assert.equal(fixture.savedSettings.strokeColor, "#FF8800");
});

test("includes system font and black stroke color in the defaults", () => {
    const settings = currentSettings(loadMainFixture());
    assert.equal(settings.fontFamily, "system");
    assert.equal(settings.strokeColor, "#000000");
    assert.equal(settings.strokeWidth, 1);
});

test("migrates stored settings on startup when keys are missing or stale", () => {
    const fixture = loadMainFixture({ settings: { fontSize: 25, opacity: 50 } });
    assert.equal(fixture.savedSettings.fontFamily, "system");
    assert.equal(fixture.savedSettings.strokeColor, "#000000");
    assert.equal(fixture.savedSettings.fontSize, 25);
    assert.equal(fixture.savedSettings.opacity, 50);
    assert.equal(fixture.preferenceSyncCalls, 1);
});

test("migrates full default settings when nothing was stored yet", () => {
    const fixture = loadMainFixture();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.savedSettings)), {
        enabled: true, showTop: true, showBottom: true, fontSize: 25,
        fontFamily: "system", strokeWidth: 1, strokeColor: "#000000",
        opacity: 100, speed: 680, offset: 0
    });
    assert.equal(fixture.preferenceSyncCalls, 1);
});

test("skips the migration save when stored settings are complete and valid", () => {
    const full = {
        enabled: true, showTop: true, showBottom: true,
        fontSize: 25, fontFamily: "PingFang SC", strokeWidth: 1.5,
        strokeColor: "#123abc", opacity: 80, speed: 680, offset: 0
    };
    const fixture = loadMainFixture({ settings: full });
    assert.equal(fixture.savedSettings, null);
    assert.equal(fixture.preferenceSyncCalls, 0);
    assert.deepEqual(currentSettings(fixture), full);
});

test("sends the enumerated system font list to the sidebar and persists cache + diagnostics", async () => {
    const execCalls = [];
    const fixture = loadMainFixture({
        utilsExec: async (command, args) => {
            execCalls.push({ command, args });
            return {
                status: 0,
                stdout: JSON.stringify(["PingFang SC", " Songti SC ", 123,
                    "bad;name", "url(Font)", "a".repeat(61), null, "PingFang SC"]),
                stderr: ""
            };
        }
    });
    await wait(0);

    assert.equal(execCalls.length, 1, "first strategy succeeds, no fallback attempts");
    assert.equal(execCalls[0].command, "/usr/bin/osascript",
        "IINA utils.exec resolves bare names against its sandbox and fails; absolute path required");
    assert.deepEqual(JSON.parse(JSON.stringify(execCalls[0].args.slice(0, 3))), ["-l", "JavaScript", "-e"]);
    assert.match(execCalls[0].args[3], /NSFontManager/);
    assert.match(execCalls[0].args[3], /deepUnwrap/);
    assert.match(execCalls[0].args[3], /Array\.from/);
    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.equal(lists.length >= 1, true);
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), {
        fonts: ["PingFang SC", "Songti SC"]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.prefs.fontFamilies)),
        ["PingFang SC", "Songti SC"], "full list cached in prefs");
    assert.equal(fixture.prefs.fontEnumDiag.final, "osascript-nsfontmanager");
    assert.equal(fixture.prefs.fontEnumDiag.count, 2);
    assert.equal(fixture.prefs.fontEnumDiag.objcBridge, "absent");
    assert.equal(fixture.prefs.fontEnumDiag.attempts.length, 1);

    fixture.sidebarHandlers["sidebar-ready"]({});
    const readyList = fixture.sidebarMessages
        .filter((message) => message.name === "font-list").at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(readyList.data)), {
        fonts: ["PingFang SC", "Songti SC"]
    });
});

test("enumerates in-process when the plugin JS context exposes the ObjC bridge", async () => {
    let execCount = 0;
    const fixture = loadMainFixture({
        utilsExec: async () => { execCount += 1; throw new Error("should not exec"); },
        globals: {
            $: { NSFontManager: { sharedFontManager: { availableFontFamilies: {} } } },
            ObjC: {
                import() {},
                deepUnwrap() { return ["BridgeFont SC", "PingFang SC", "BridgeFont SC"]; }
            }
        }
    });
    await wait(0);

    assert.equal(execCount, 0, "bridge path must skip utils.exec entirely");
    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), {
        fonts: ["BridgeFont SC", "PingFang SC"]
    });
    assert.equal(fixture.prefs.fontEnumDiag.objcBridge, "ok");
    assert.equal(fixture.prefs.fontEnumDiag.final, "bridge");
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.prefs.fontFamilies)),
        ["BridgeFont SC", "PingFang SC"]);
});

test("falls through exec strategies when earlier ones fail", async () => {
    const execCalls = [];
    const fixture = loadMainFixture({
        utilsExec: async (command, args) => {
            execCalls.push({ command, args });
            if (execCalls.length === 1) {
                throw new Error("nsfontmanager blocked");
            }
            return { status: 0, stdout: JSON.stringify(["Menlo", "Kaiti SC"]), stderr: "" };
        }
    });
    await wait(0);

    assert.equal(execCalls.length, 2);
    assert.match(execCalls[0].args[3], /NSFontManager/);
    assert.match(execCalls[1].args[3], /CoreText/);
    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), {
        fonts: ["Menlo", "Kaiti SC"]
    });
    assert.equal(fixture.prefs.fontEnumDiag.final, "osascript-coretext");
    assert.equal(fixture.prefs.fontEnumDiag.attempts[0].error, "Error: nsfontmanager blocked");
});

test("caps the enumerated font list at 1000 unique sanitized entries", async () => {
    const many = [];
    for (let i = 0; i < 1500; i++) many.push("FontFamily" + i);
    many.push("FontFamily0", "FontFamily1");
    const fixture = loadMainFixture({
        utilsExec: async () => ({ status: 0, stdout: JSON.stringify(many), stderr: "" })
    });
    await wait(0);

    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    const fonts = JSON.parse(JSON.stringify(lists.at(-1).data)).fonts;
    assert.equal(fonts.length, 1000);
    assert.equal(fonts[0], "FontFamily0");
    assert.equal(new Set(fonts).size, 1000, "duplicates removed");
});

test("uses the persisted font cache when live enumeration is unavailable", async () => {
    const execCalls = [];
    const fixture = loadMainFixture({
        utilsExec: async (command, args) => {
            execCalls.push({ command, args });
            throw new Error("osascript failed");
        },
        prefs: { fontFamilies: ["CachedFont A", "CachedFont B"] }
    });
    await wait(0);

    assert.equal(execCalls.length, 2, "every live strategy is attempted before cache fallback");
    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), {
        fonts: ["CachedFont A", "CachedFont B"]
    });
    assert.equal(fixture.prefs.fontEnumDiag.final, "cache");
    assert.equal(fixture.prefs.fontEnumDiag.count, 2);
});

test("sends a null font list when enumeration and cache are both unavailable", async () => {
    const execCalls = [];
    const fixture = loadMainFixture({
        utilsExec: async (command, args) => {
            execCalls.push({ command, args });
            throw new Error("osascript failed");
        }
    });
    await wait(0);

    assert.equal(execCalls.length, 2);
    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.equal(lists.length >= 1, true);
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), { fonts: null });
    assert.equal(fixture.prefs.fontEnumDiag.final, "fallback");
    assert.equal(fixture.prefs.fontEnumDiag.attempts.length, 2);

    fixture.sidebarHandlers["sidebar-ready"]({});
    const readyList = fixture.sidebarMessages
        .filter((message) => message.name === "font-list").at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(readyList.data)), { fonts: null });
});

test("treats empty or non-array enumeration output as failure for that strategy", async () => {
    const fixture = loadMainFixture({
        utilsExec: async (command, args) => {
            if (/NSFontManager/.test(args[3])) {
                return { status: 0, stdout: "[]", stderr: "" };
            }
            return { status: 0, stdout: "null", stderr: "" };
        }
    });
    await wait(0);

    const lists = fixture.sidebarMessages.filter((message) => message.name === "font-list");
    assert.deepEqual(JSON.parse(JSON.stringify(lists.at(-1).data)), { fonts: null });
    assert.equal(fixture.prefs.fontEnumDiag.final, "fallback");
});
