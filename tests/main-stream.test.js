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
        status: {
            idle: false,
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
        }
    };
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
                get(key) { return key === "settings" ? options.settings || null : null; },
                set(key, value) {
                    if (key === "settings") savedSettings = value;
                },
                sync() { preferenceSyncCalls += 1; }
            }
        }
    };
    if (options.parseJson) {
        context.JSON = { parse: options.parseJson, stringify: JSON.stringify };
    }
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, "..", "main.js"), "utf8"
    ), context);
    return {
        eventHandlers, sidebarHandlers, overlayHandlers, overlayMessages, sidebarMessages,
        clock, xmls, core: context.iina.core,
        get mpvPosition() { return mpvPosition; },
        set mpvPosition(value) { mpvPosition = value; },
        get setClickableCalls() { return setClickableCalls; },
        get savedSettings() { return savedSettings; },
        get preferenceSyncCalls() { return preferenceSyncCalls; }
    };
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
    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").length, 1);
    fixture.clock.now = 1033;
    fixture.eventHandlers["mpv.time-pos.changed"](10.05);
    assert.equal(fixture.overlayMessages.filter((message) =>
        message.name === "playback-state").length, 2);
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
    assert.equal(fixture.preferenceSyncCalls, 1);
    const settings = fixture.sidebarMessages.filter((message) => message.name === "settings");
    assert.equal(settings.at(-1).data.settings.fontSize, 32);
});
