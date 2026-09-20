// danmaku.js — runs inside the overlay WKWebView (no iina API here,
// only iina.postMessage / iina.onMessage to talk to main.js).
// Renders Bilibili XML through CommentCoreLibrary with incremental parsing.

const MAX_ACTIVE_COMMENTS = 240;
const COMMENT_BATCH_SIZE = 200;
const FALLBACK_CHUNK_SIZE = 16 * 1024;
const PROGRESS_INTERVAL = 400;
const LATE_COMMENT_WINDOW = 1000;
const FONT_PRESETS = {
    system: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    sans: 'Arial, "Helvetica Neue", sans-serif',
    serif: 'Songti SC, "STSong", serif',
    rounded: '"Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", sans-serif',
    mono: 'Menlo, Monaco, monospace'
};

let cm = null;
let parserWorker = null;
let workerMessageCount = 0;
let workerEndForwarded = false;
let lastWorkerChunk = null;
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
let seeking = false;
let playbackRate = 1;
let playbackRevision = null;
let streamAvailable = false;
let progressReportedAt = 0;
let pendingComments = [];
let commentHistory = [];

// M4 overlay-side settings (mirrors main.js, applied on stream start / live update).
let ov = {
    speed: 680, fontSize: 25, fontFamily: "system", strokeWidth: 1,
    strokeColor: "#000000", showTop: true, showBottom: true
};

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
    const onTimerEvent = cm.onTimerEvent;
    if (typeof onTimerEvent === "function") {
        cm.onTimerEvent = function (timePassed, manager) {
            return onTimerEvent.call(this, timePassed * playbackRate, manager);
        };
    }
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

function rebuildAtTime(time) {
    currentTime = time;
    hasTime = true;
    if (!cm) {
        return;
    }
    cm.clear();
    rebuildPendingComments(time);
    if (!paused && !seeking) {
        flushDueComments(time);
    }
}

function applyPlaybackRate(rate) {
    playbackRate = rate;
    if (!cm) {
        return;
    }
    cm.runline.forEach((comment) => {
        if (!comment.dom || typeof comment.dom.getAnimations !== "function") {
            return;
        }
        comment.dom.getAnimations().forEach((animation) => {
            animation.playbackRate = rate;
        });
    });
}

function applyPlaybackState(data) {
    const time = Number(data && data.time);
    const rate = Number(data && data.rate);
    const revision = Number(data && data.revision);
    if (!Number.isFinite(time) || !Number.isFinite(rate) || rate <= 0 ||
        !Number.isInteger(revision) || revision < 0 ||
        (playbackRevision !== null && revision < playbackRevision)) {
        return;
    }
    const hadPlaybackState = playbackRevision !== null;
    const wasBlocked = paused || seeking;
    const revisionChanged = hadPlaybackState && revision !== playbackRevision;
    const missedSeekingEvent = !revisionChanged && hasTime &&
        (time < currentTime - 0.25 || Math.abs(time - currentTime) > 5.5);
    paused = Boolean(data.paused);
    seeking = Boolean(data.seeking);
    playbackRevision = revision;
    applyPlaybackRate(rate);
    if (!cm) {
        return;
    }
    if (paused || seeking) {
        if (revisionChanged || missedSeekingEvent) {
            rebuildAtTime(time);
        } else {
            currentTime = time;
            hasTime = true;
        }
        cm.stop();
        return;
    }
    if (!hadPlaybackState || wasBlocked) {
        cm.start();
    }
    if (revisionChanged || missedSeekingEvent) {
        rebuildAtTime(time);
    } else {
        currentTime = time;
        hasTime = true;
        flushDueComments(time);
    }
}

function flushDueComments(time) {
    if (!cm || paused || seeking || !Number.isFinite(time)) {
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
            applyPlaybackRate(playbackRate);
            const applyRateAfterAnimationsExist = () => applyPlaybackRate(playbackRate);
            if (typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(applyRateAfterAnimationsExist);
            } else {
                setTimeout(applyRateAfterAnimationsExist, 0);
            }
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

// Free-form family names must survive the same defensive rule used upstream:
// trimmed, length 1-60, no CSS/URL/quote metacharacters, no case-insensitive "url(".
function sanitizeFontFamily(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
        return null;
    }
    if (!/^[^;{}()<>\\",'\r\n]+$/.test(trimmed)) {
        return null;
    }
    if (/url\(/i.test(trimmed)) {
        return null;
    }
    return trimmed;
}

function resolveFontFamily(value) {
    if (Object.prototype.hasOwnProperty.call(FONT_PRESETS, value)) {
        return FONT_PRESETS[value];
    }
    const family = sanitizeFontFamily(value);
    if (family !== null) {
        return "'" + family + "', " + FONT_PRESETS.system;
    }
    return FONT_PRESETS.system;
}

function applyFontFamily() {
    if (!cm) {
        return;
    }
    const font = resolveFontFamily(ov.fontFamily);
    // Timeline entries are shared with the pending queue and replay history.
    cm.timeline.forEach((comment) => { comment.font = font; });
    cm.runline.forEach((comment) => { comment.font = font; });
}

function sanitizeStrokeColor(value) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
        ? value : "#000000";
}

function applyStrokeStyle() {
    document.documentElement.style.setProperty(
        "--danmaku-stroke-width", ov.strokeWidth + "px"
    );
    document.documentElement.style.setProperty(
        "--danmaku-stroke-color", ov.strokeColor
    );
}

function updateTypography(data) {
    if (data.fontFamily !== undefined) {
        let family = "system";
        if (Object.prototype.hasOwnProperty.call(FONT_PRESETS, data.fontFamily)) {
            family = data.fontFamily;
        } else {
            const custom = sanitizeFontFamily(data.fontFamily);
            if (custom !== null) {
                family = custom;
            }
        }
        if (family !== ov.fontFamily) {
            ov.fontFamily = family;
            applyFontFamily();
        }
    }
    if (data.strokeWidth !== undefined && Number.isFinite(Number(data.strokeWidth))) {
        ov.strokeWidth = Math.round(Math.max(0, Math.min(3, Number(data.strokeWidth))) * 2) / 2;
    }
    if (data.strokeColor !== undefined) {
        ov.strokeColor = sanitizeStrokeColor(data.strokeColor);
    }
    applyStrokeStyle();
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
        comment.font = resolveFontFamily(ov.fontFamily);
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
    if (hasTime && !paused && !seeking) {
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
    seeking = false;
    playbackRevision = null;
    iina.postMessage("stream-state", {
        streamId: failedStreamId,
        phase: "error",
        parsed: 0,
        accepted: 0,
        skipped: 0,
        message: message
    });
    iina.postMessage("overlay-error", { streamId: failedStreamId, message: message });
}

function handleWorkerMessage(event) {
    const data = event.data || {};
    if (data.streamId !== activeStreamId) {
        return;
    }
    workerMessageCount += 1;
    if (data.type === "comments") {
        appendComments(data.streamId, data.comments, data);
    } else if (data.type === "progress") {
        reportProgress(data);
    } else if (data.type === "chunk-consumed") {
        iina.postMessage("stream-chunk-consumed", {
            streamId: data.streamId,
            chunkId: data.chunkId
        });
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
    const entry = fallbackQueue.shift();
    if (entry) {
        try {
            const stats = fallbackParser.push(entry.chunk);
            reportProgress(stats);
            if (entry.acknowledge) {
                iina.postMessage("stream-chunk-consumed", {
                    streamId: activeStreamId,
                    chunkId: entry.chunkId
                });
            }
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
    workerMessageCount = 0;
    workerEndForwarded = false;
    lastWorkerChunk = null;
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

function enqueueFallbackChunk(chunkId, chunk) {
    if (chunk.length === 0) {
        fallbackQueue.push({ chunk: "", acknowledge: true, chunkId: chunkId });
    } else {
        for (let offset = 0; offset < chunk.length; offset += FALLBACK_CHUNK_SIZE) {
            fallbackQueue.push({
                chunk: chunk.slice(offset, offset + FALLBACK_CHUNK_SIZE),
                acknowledge: offset + FALLBACK_CHUNK_SIZE >= chunk.length,
                chunkId: chunkId
            });
        }
    }
    scheduleFallbackPump();
}

function startParser(streamId) {
    try {
        const worker = new Worker("parser-worker.js");
        parserWorker = worker;
        workerMessageCount = 0;
        workerEndForwarded = false;
        lastWorkerChunk = null;
        worker.onmessage = handleWorkerMessage;
        worker.onerror = (event) => {
            if (parserWorker !== worker) {
                return;
            }
            parserWorker = null;
            try {
                worker.terminate();
            } catch (e) { /* ignore */ }
            if (workerMessageCount > 0) {
                handleParserError(streamId, event.message || "parser worker failed");
                return;
            }
            // The worker never produced output, e.g. WKWebView blocks worker
            // scripts on file:// URLs. Fall back and replay its last chunk.
            startFallback(streamId);
            if (fallbackParser) {
                if (lastWorkerChunk) {
                    enqueueFallbackChunk(lastWorkerChunk.chunkId, lastWorkerChunk.chunk);
                    lastWorkerChunk = null;
                }
                if (workerEndForwarded) {
                    fallbackEndPending = true;
                    scheduleFallbackPump();
                }
            }
        };
        worker.postMessage({ type: "start", streamId: streamId });
    } catch (error) {
        parserWorker = null;
        startFallback(streamId);
    }
}

function updateSettings(data) {
    updateTypography(data || {});
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
    paused = false;
    seeking = false;
    playbackRate = 1;
    playbackRevision = null;
    streamAvailable = false;
    progressReportedAt = 0;
    updateSettings(data.settings);
    resetManager();
    applyPlaybackState(data.playbackState || {
        time: Number(data.initialTime) || 0,
        paused: Boolean(data.paused),
        rate: 1,
        seeking: false,
        revision: 0
    });
    startParser(activeStreamId);
});

iina.onMessage("stream-chunk", (data) => {
    if (!data || data.streamId !== activeStreamId || typeof data.chunk !== "string") {
        return;
    }
    try {
        if (parserWorker) {
            lastWorkerChunk = { chunkId: data.chunkId, chunk: data.chunk };
            parserWorker.postMessage({
                type: "chunk",
                streamId: data.streamId,
                chunkId: data.chunkId,
                chunk: data.chunk
            });
            return;
        }
        if (fallbackParser) {
            enqueueFallbackChunk(data.chunkId, data.chunk);
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
            workerEndForwarded = true;
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
    updateTypography(data);
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

iina.onMessage("playback-state", applyPlaybackState);

iina.onMessage("resize", resize);

iina.onMessage("clear", () => {
    stopParser();
    activeStreamId = null;
    currentTitle = "";
    streamAvailable = false;
    currentTime = 0;
    hasTime = false;
    seeking = false;
    playbackRevision = null;
    resetManager();
});

document.addEventListener("visibilitychange", () => {
    if (cm && cm.setHidden) {
        cm.setHidden(document.hidden);
    }
    if (!document.hidden && hasTime && !paused && !seeking) {
        flushDueComments(currentTime);
    }
});
window.addEventListener("resize", resize);
