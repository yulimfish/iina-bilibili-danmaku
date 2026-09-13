// danmaku.js — runs inside the overlay WKWebView (no iina API here,
// only iina.postMessage / iina.onMessage to talk to main.js).
// Renders Bilibili XML through CommentCoreLibrary with incremental parsing.

const MAX_ACTIVE_COMMENTS = 240;
const COMMENT_BATCH_SIZE = 200;
const FALLBACK_CHUNK_SIZE = 16 * 1024;
const PROGRESS_INTERVAL = 400;
const LATE_COMMENT_WINDOW = 1000;

let cm = null;
let parserWorker = null;
let fallbackParser = null;
let fallbackQueue = [];
let fallbackEndPending = false;
let fallbackScheduled = false;
let fallbackPumpToken = 0;
let activeStreamId = null;
let currentTitle = "";
let currentTime = 0;
let hasTime = false;
let paused = false;
let streamAvailable = false;
let progressReportedAt = 0;
let pendingComments = [];
let commentHistory = [];

// M4 overlay-side settings (mirrors main.js, applied on stream start / live update).
let ov = { speed: 680, fontSize: 25, showTop: true, showBottom: true };

// The plugin registers its overlay listeners after the navigation-finished
// event, so respond to a ping to prove this is the overlay webview (not the
// sidebar webview, which emits the same IINA event).
iina.onMessage("ping", () => {
    iina.postMessage("overlay-ready", {});
});

function ensureCM() {
    if (cm) {
        return;
    }
    cm = new CommentManager(document.getElementById("commentCanvas"));
    cm.init();
    // Drop advanced / code / BAS comments (mode 7/8/9).
    cm.filter.allowUnknownTypes = false;
    cm.options.limit = MAX_ACTIVE_COMMENTS;
    applyFilter();
    resize();
}

function applyFilter() {
    if (!cm) {
        return;
    }
    cm.filter.allowTypes[5] = ov.showTop;
    cm.filter.allowTypes[4] = ov.showBottom;
}

function resize() {
    if (!cm) {
        return;
    }
    const stage = document.getElementById("stage");
    const width = (stage && stage.offsetWidth) || window.innerWidth || ov.speed;
    cm.options.scroll.scale = width / ov.speed;
    cm.setBounds();
}

function resetManager() {
    pendingComments = [];
    commentHistory = [];
    if (!cm) {
        return;
    }
    cm.clear();
    cm.timeline = [];
    cm.position = 0;
    cm.seek(0);
    cm._lastPosition = 0;
}

function compareComments(left, right) {
    if (left.stime < right.stime) return -1;
    if (left.stime > right.stime) return 1;
    return 0;
}

function pushPendingComment(comment) {
    pendingComments.push(comment);
    let index = pendingComments.length - 1;
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (compareComments(pendingComments[parent], comment) <= 0) {
            break;
        }
        pendingComments[index] = pendingComments[parent];
        index = parent;
    }
    pendingComments[index] = comment;
}

function popPendingComment() {
    const first = pendingComments[0];
    const last = pendingComments.pop();
    if (pendingComments.length > 0) {
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let child = left;
            if (right < pendingComments.length &&
                compareComments(pendingComments[right], pendingComments[left]) < 0) {
                child = right;
            }
            if (child >= pendingComments.length ||
                compareComments(pendingComments[child], last) >= 0) {
                break;
            }
            pendingComments[index] = pendingComments[child];
            index = child;
        }
        pendingComments[index] = last;
    }
    return first;
}

function rebuildPendingComments(time) {
    const start = Math.floor(time * 1000) - LATE_COMMENT_WINDOW;
    pendingComments = commentHistory.filter((comment) => comment.stime >= start);
    for (let index = Math.floor(pendingComments.length / 2) - 1; index >= 0; index -= 1) {
        const value = pendingComments[index];
        let current = index;
        while (true) {
            const left = current * 2 + 1;
            const right = left + 1;
            let child = left;
            if (right < pendingComments.length &&
                compareComments(pendingComments[right], pendingComments[left]) < 0) {
                child = right;
            }
            if (child >= pendingComments.length ||
                compareComments(pendingComments[child], value) >= 0) {
                break;
            }
            pendingComments[current] = pendingComments[child];
            current = child;
        }
        pendingComments[current] = value;
    }
}

function flushDueComments(time) {
    if (!cm || paused || !Number.isFinite(time)) {
        return;
    }
    const dueTime = time * 1000;
    const staleBefore = dueTime - LATE_COMMENT_WINDOW;
    while (pendingComments.length > 0 && pendingComments[0].stime < staleBefore) {
        popPendingComment();
    }
    if (cm._accepting === false) {
        return;
    }
    const capacity = Math.max(0, MAX_ACTIVE_COMMENTS - cm.runline.length);
    const due = [];
    try {
        while (pendingComments.length > 0 && pendingComments[0].stime <= dueTime) {
            const comment = popPendingComment();
            if (due.length < capacity && cm.validate(comment)) {
                due.push(comment);
            }
        }
        if (due.length > 0) {
            cm.send(due);
        }
    } catch (error) {
        handleParserError(activeStreamId, String((error && error.message) || error));
    }
}

function postStreamState(phase, stats) {
    const data = { streamId: activeStreamId, phase: phase };
    if (stats) {
        data.parsed = stats.parsed;
        data.accepted = stats.accepted;
        data.skipped = stats.skipped;
    }
    iina.postMessage("stream-state", data);
}

function reportProgress(stats) {
    const now = Date.now();
    if (now - progressReportedAt < PROGRESS_INTERVAL) {
        return;
    }
    progressReportedAt = now;
    postStreamState(streamAvailable ? "progress" : "parsing", stats);
}

function applyFontSize() {
    if (!cm) {
        return;
    }
    cm.timeline.forEach((comment) => {
        comment.size = ov.fontSize;
    });
    cm.runline.forEach((comment) => {
        comment.size = ov.fontSize;
    });
}

function appendComments(streamId, comments, stats) {
    if (streamId !== activeStreamId || !cm || !Array.isArray(comments)) {
        return;
    }
    const staleBefore = hasTime
        ? currentTime * 1000 - LATE_COMMENT_WINDOW
        : -Infinity;
    comments.forEach((comment) => {
        comment.size = ov.fontSize;
        commentHistory.push(comment);
        if (comment.stime >= staleBefore) {
            pushPendingComment(comment);
        }
    });
    cm.timeline.push(...comments);
    if (!streamAvailable && comments.length > 0) {
        streamAvailable = true;
        postStreamState("available", stats);
        iina.postMessage("loaded", {
            streamId: streamId,
            title: currentTitle,
            accepted: stats && stats.accepted
        });
    }
    if (hasTime && !paused) {
        flushDueComments(currentTime);
    }
}

function completeStream(streamId, stats) {
    if (streamId !== activeStreamId) {
        return;
    }
    if (stats.accepted > 0) {
        postStreamState("complete", stats);
    } else {
        postStreamState("empty", stats);
    }
}

function handleParserError(streamId, message) {
    if (streamId !== activeStreamId) {
        return;
    }
    const failedStreamId = activeStreamId;
    resetManager();
    if (cm) {
        cm.stop();
    }
    stopParser();
    activeStreamId = null;
    currentTitle = "";
    streamAvailable = false;
    currentTime = 0;
    hasTime = false;
    iina.postMessage("stream-state", {
        streamId: failedStreamId,
        phase: "error",
        parsed: 0,
        accepted: 0,
        skipped: 0
    });
    iina.postMessage("overlay-error", { streamId: failedStreamId, message: message });
}

function handleWorkerMessage(event) {
    const data = event.data || {};
    if (data.streamId !== activeStreamId) {
        return;
    }
    if (data.type === "comments") {
        appendComments(data.streamId, data.comments, data);
    } else if (data.type === "progress") {
        reportProgress(data);
    } else if (data.type === "complete") {
        completeStream(data.streamId, data);
    } else if (data.type === "error") {
        handleParserError(data.streamId, data.message || "parser worker failed");
    }
}

function scheduleFallbackPump() {
    if (fallbackScheduled || !fallbackParser) {
        return;
    }
    fallbackScheduled = true;
    const token = fallbackPumpToken;
    setTimeout(() => runFallbackPump(token), 0);
}

function finishFallback() {
    if (!fallbackParser || activeStreamId === null) {
        return;
    }
    const streamId = activeStreamId;
    try {
        const stats = fallbackParser.finish();
        fallbackEndPending = false;
        fallbackParser = null;
        completeStream(streamId, stats);
    } catch (error) {
        fallbackParser = null;
        handleParserError(streamId, String((error && error.message) || error));
    }
}

function runFallbackPump(token) {
    fallbackScheduled = false;
    if (token !== fallbackPumpToken || !fallbackParser) {
        return;
    }
    const chunk = fallbackQueue.shift();
    if (chunk) {
        try {
            const stats = fallbackParser.push(chunk);
            reportProgress(stats);
        } catch (error) {
            handleParserError(activeStreamId, String((error && error.message) || error));
            return;
        }
    }
    if (fallbackQueue.length > 0) {
        scheduleFallbackPump();
    } else if (fallbackEndPending) {
        finishFallback();
    }
}

function startFallback(streamId) {
    if (!window.BiliDanmakuParser) {
        handleParserError(streamId, "streaming parser is unavailable");
        return;
    }
    try {
        fallbackParser = window.BiliDanmakuParser.createStreamingParser(
            (comments, stats) => appendComments(streamId, comments, stats),
            COMMENT_BATCH_SIZE
        );
        postStreamState("parsing", { parsed: 0, accepted: 0, skipped: 0 });
    } catch (error) {
        handleParserError(streamId, String((error && error.message) || error));
    }
}

function stopParser() {
    fallbackPumpToken += 1;
    fallbackQueue = [];
    fallbackEndPending = false;
    fallbackScheduled = false;
    if (parserWorker) {
        try {
            parserWorker.postMessage({ type: "cancel", streamId: activeStreamId });
        } catch (e) { /* ignore */ }
        try {
            parserWorker.terminate();
        } catch (e) { /* ignore */ }
    }
    parserWorker = null;
    fallbackParser = null;
}

function startParser(streamId) {
    try {
        parserWorker = new Worker("parser-worker.js");
        parserWorker.onmessage = handleWorkerMessage;
        parserWorker.onerror = (event) => {
            handleParserError(streamId, event.message || "parser worker failed");
        };
        parserWorker.postMessage({ type: "start", streamId: streamId });
    } catch (error) {
        parserWorker = null;
        startFallback(streamId);
    }
}

function updateSettings(data) {
    if (!data) {
        return;
    }
    if (Number.isFinite(Number(data.speed)) && Number(data.speed) > 0) {
        ov.speed = Number(data.speed);
    }
    if (Number.isFinite(Number(data.fontSize)) && Number(data.fontSize) > 0) {
        ov.fontSize = Number(data.fontSize);
    }
    ov.showTop = data.showTop !== false;
    ov.showBottom = data.showBottom !== false;
    applyFilter();
    resize();
    applyFontSize();
}

iina.onMessage("stream-start", (data) => {
    if (!data || data.streamId === undefined || data.streamId === null) {
        return;
    }
    stopParser();
    ensureCM();
    activeStreamId = data.streamId;
    currentTitle = data.title || "";
    if (typeof data.paused === "boolean") {
        paused = data.paused;
    }
    streamAvailable = false;
    progressReportedAt = 0;
    updateSettings(data.settings);
    const initialTime = Number(data.initialTime);
    currentTime = Number.isFinite(initialTime) ? initialTime : 0;
    hasTime = Number.isFinite(initialTime);
    resetManager();
    if (paused) {
        cm.stop();
    } else {
        cm.start();
    }
    startParser(activeStreamId);
});

iina.onMessage("stream-chunk", (data) => {
    if (!data || data.streamId !== activeStreamId || typeof data.chunk !== "string") {
        return;
    }
    try {
        if (parserWorker) {
            parserWorker.postMessage({
                type: "chunk",
                streamId: data.streamId,
                chunk: data.chunk
            });
            return;
        }
        if (fallbackParser) {
            for (let offset = 0; offset < data.chunk.length; offset += FALLBACK_CHUNK_SIZE) {
                fallbackQueue.push(data.chunk.slice(offset, offset + FALLBACK_CHUNK_SIZE));
            }
            scheduleFallbackPump();
        }
    } catch (error) {
        handleParserError(data.streamId, String((error && error.message) || error));
    }
});

iina.onMessage("stream-end", (data) => {
    if (!data || data.streamId !== activeStreamId) {
        return;
    }
    try {
        if (parserWorker) {
            parserWorker.postMessage({ type: "end", streamId: data.streamId });
        } else if (fallbackParser) {
            fallbackEndPending = true;
            scheduleFallbackPump();
        }
    } catch (error) {
        handleParserError(data.streamId, String((error && error.message) || error));
    }
});

iina.onMessage("filter", (data) => {
    ov.showTop = data.showTop !== false;
    ov.showBottom = data.showBottom !== false;
    applyFilter();
});

iina.onMessage("style", (data) => {
    if (!data) {
        return;
    }
    if (Number.isFinite(Number(data.speed)) && Number(data.speed) > 0 &&
        Number(data.speed) !== ov.speed) {
        ov.speed = Number(data.speed);
        resize();
    }
    if (Number.isFinite(Number(data.fontSize)) && Number(data.fontSize) > 0 &&
        Number(data.fontSize) !== ov.fontSize) {
        ov.fontSize = Number(data.fontSize);
        applyFontSize();
    }
});

iina.onMessage("time", (data) => {
    const nextTime = Number(data && data.time);
    if (!Number.isFinite(nextTime)) {
        return;
    }
    const jumped = hasTime && (nextTime < currentTime - 0.25 ||
        Math.abs(nextTime - currentTime) > 5.5);
    currentTime = nextTime;
    hasTime = true;
    if (!cm) {
        return;
    }
    if (jumped) {
        cm.clear();
        rebuildPendingComments(nextTime);
    }
    if (!paused) {
        flushDueComments(nextTime);
    }
});

iina.onMessage("pause", (data) => {
    paused = Boolean(data && data.paused);
    if (!cm) {
        return;
    }
    if (paused) {
        cm.stop();
    } else {
        cm.start();
        if (hasTime) {
            flushDueComments(currentTime);
        }
    }
});

iina.onMessage("resize", resize);

iina.onMessage("clear", () => {
    stopParser();
    activeStreamId = null;
    currentTitle = "";
    streamAvailable = false;
    currentTime = 0;
    hasTime = false;
    resetManager();
});

document.addEventListener("visibilitychange", () => {
    if (cm && cm.setHidden) {
        cm.setHidden(document.hidden);
    }
    if (!document.hidden && hasTime && !paused) {
        flushDueComments(currentTime);
    }
});
window.addEventListener("resize", resize);
