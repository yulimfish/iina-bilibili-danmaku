// main.js — per-player entry.
//
// M1: sidebar panel lifecycle, main-entry menu, toggle state.
// M2: BV-source channel — view API -> parts -> cid -> danmaku XML -> overlay.
// M3: bangumi channel — search / ep-ss-md links -> seasons -> episodes -> cid.
// M4: danmaku controls — toggle / font / opacity / speed / offset / clear.

const { core, console, menu, sidebar, overlay, event, mpv, http, preferences } = iina;

const TAG = "[bili-danmaku]";
const BILI_HEADERS = {
    "Referer": "https://www.bilibili.com",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
};

// ---------------------------------------------------------------------------
// M1: sidebar toggle + menus
// ---------------------------------------------------------------------------

let sidebarVisible = false;

function showSidebar() {
    if (!core.window.loaded) {
        console.log(TAG + " cannot show sidebar before window-loaded");
        return;
    }
    sidebar.show();
    sidebarVisible = true;
    console.log(TAG + " sidebar shown");
}

function hideSidebar() {
    if (!core.window.loaded) {
        return;
    }
    sidebar.hide();
    sidebarVisible = false;
    console.log(TAG + " sidebar hidden");
}

function toggleSidebar() {
    if (sidebarVisible) {
        hideSidebar();
    } else {
        showSidebar();
    }
}

const rootItem = menu.item("Bili Danmaku");
rootItem.addSubMenuItem(menu.item("Toggle Danmaku Panel", toggleSidebar));
menu.addItem(rootItem);

// Sidebar and overlay views require an initialized player window. Loading the
// sidebar before window-loaded raises an exception and aborts the entry file.
let sidebarInitialized = false;
function initializeSidebar() {
    if (sidebarInitialized || !core.window.loaded) {
        return;
    }
    sidebarInitialized = true;
    sidebar.loadFile("sidebar/index.html");
    console.log(TAG + " sidebar file loaded");

    // IINA clears sidebar message listeners inside loadFile, so request
    // handlers must be registered after the file is loaded.
    sidebar.onMessage("load-source", (data) => {
        return loadSource(data && data.text);
    });
    sidebar.onMessage("search-bangumi", (data) => {
        return requestBangumiSearch(data && data.keyword);
    });
    sidebar.onMessage("select-season", (data) => {
        if (!data || !data.season_id) {
            return;
        }
        const token = invalidateCurrentLoad();
        return loadSeasonById(String(data.season_id), token, null);
    });
    sidebar.onMessage("select-part", (data) => {
        if (!video || !data) {
            return;
        }
        const index = data.index;
        if (index < 0 || index >= video.parts.length || index === video.index) {
            return;
        }
        const token = invalidateCurrentLoad();
        return loadPart(index, token).catch((e) => {
            if (token === loadToken) {
                reportError(e);
            }
        });
    });

    sidebar.onMessage("sidebar-ready", () => {
        console.log(TAG + " sidebar ready");
        sidebar.postMessage("state", { loaded: false, status: "idle" });
        sidebar.postMessage("settings", { settings: settings });
    });
    sidebar.onMessage("update-settings", (data) => {
        if (data && data.patch) {
            applySettings(data.patch);
        }
    });
    sidebar.onMessage("clear-danmaku", () => {
        invalidateCurrentLoad();
        sidebar.postMessage("status", { text: "已清空弹幕" });
        console.log(TAG + " danmaku cleared");
    });
}
event.on("iina.window-loaded", initializeSidebar);
// Covers a player whose window was already loaded before this entry ran.
if (core.window.loaded) {
    initializeSidebar();
}

// ---------------------------------------------------------------------------
// M2: Bilibili BV channel
// ---------------------------------------------------------------------------

// Current video source. XML itself is forwarded to the overlay, not cached.
let video = null; // { bvid, title, parts: [{page, part, cid}], index }
let overlayRequested = false; // overlay.loadFile called
let overlayLoaded = false; // overlay answered the private readiness ping
let overlayMessagesRegistered = false;
let pendingStream = null; // load arrived before overlay webview was ready
let nextStreamId = 0;
let currentStreamId = 0;
let streamPumpGeneration = 0;
let acknowledgeStreamChunk = null;
let danmakuActive = false;
let streamLoading = false;
let loadToken = 0; // guards against overlapping loadSource calls
let pendingSearch = null;
let playbackState = {
    time: null,
    paused: false,
    rate: 1,
    seeking: false,
    revision: 0
};
let lastPlaybackStateSentAt = 0;
const XML_CHUNK_SIZE = 128 * 1024;
const TIME_UPDATE_INTERVAL = 33;

// ---------------------------------------------------------------------------
// M4: settings (persisted, synced to sidebar + overlay)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
    enabled: true, // overlay visible
    showTop: true, // fixed top comments (mode 5)
    showBottom: true, // fixed bottom comments (mode 4)
    fontSize: 25, // px, replaces per-comment size
    opacity: 100, // 0-100
    speed: 680, // CCL scroll baseline; larger = faster
    offset: 0 // seconds added to playback position
};

let settings = Object.assign({}, DEFAULT_SETTINGS);

function loadSettings() {
    try {
        const saved = preferences.get("settings");
        if (saved && typeof saved === "object") {
            settings = Object.assign({}, DEFAULT_SETTINGS, saved);
        }
    } catch (e) { /* ignore */ }
}

function saveSettings() {
    try {
        preferences.set("settings", settings);
        preferences.sync();
    } catch (e) { /* ignore */ }
}

function overlaySettings() {
    return {
        speed: settings.speed,
        fontSize: settings.fontSize,
        showTop: settings.showTop,
        showBottom: settings.showBottom
    };
}

function applySettings(patch) {
    Object.assign(settings, patch);
    saveSettings();
    if (pendingStream) {
        pendingStream.settings = overlaySettings();
    }
    if ("offset" in patch) {
        playbackState.revision += 1;
    }
    if (overlayLoaded) {
        if ("enabled" in patch) {
            if (settings.enabled) {
                overlay.show();
            } else {
                overlay.hide();
            }
        }
        if ("opacity" in patch) {
            overlay.setOpacity(settings.opacity / 100);
        }
        if ("showTop" in patch || "showBottom" in patch) {
            overlay.postMessage("filter", { showTop: settings.showTop, showBottom: settings.showBottom });
        }
        if ("speed" in patch || "fontSize" in patch) {
            overlay.postMessage("style", { speed: settings.speed, fontSize: settings.fontSize });
        }
        if ("offset" in patch) {
            sendPlaybackState(true);
        }
    }
    sidebar.postMessage("settings", { settings: settings });
}

loadSettings();

function extractBvid(text) {
    const m = /BV[a-zA-Z0-9]{10}/.exec((text || "").trim());
    return m ? m[0] : null;
}

async function biliApi(path, params, extraHeaders, isStale) {
    const headers = Object.assign({}, BILI_HEADERS, extraHeaders || {});
    const res = await http.get("https://api.bilibili.com" + path, {
        params: params,
        headers: headers,
        data: {}
    });
    if (isStale && isStale()) {
        return null;
    }
    if (res.statusCode !== 200) {
        throw { network: true, status: res.statusCode };
    }
    let body;
    try {
        body = JSON.parse(res.text);
    } catch (e) {
        throw { network: true, status: res.statusCode };
    }
    if (body.code !== 0) {
        throw { biliCode: body.code, biliMessage: body.message };
    }
    // Main-site APIs use `data`, pgc APIs use `result`.
    return body.result !== undefined ? body.result : body.data;
}

async function biliDanmakuXml(cid) {
    const res = await http.get("https://api.bilibili.com/x/v1/dm/list.so", {
        params: { oid: String(cid) },
        headers: BILI_HEADERS,
        data: {}
    });
    if (res.statusCode !== 200) {
        throw { network: true, status: res.statusCode };
    }
    return res.text;
}

function reportError(e) {
    let msg = "网络请求失败，请检查网络后重试";
    if (e && (e.biliCode === -404 || e.biliCode === 62002)) {
        msg = "视频不存在或不可见（BV 号无效、视频已删除或仅自己可见）";
    } else if (e && e.biliCode === -403) {
        msg = "访问被拒绝（可能为地区/权限限制）";
    } else if (e && e.biliCode === -412) {
        msg = "请求被 B 站风控拦截，稍后重试";
    } else if (e && e.biliCode) {
        msg = "B 站返回错误 " + e.biliCode + "：" + (e.biliMessage || "未知错误");
    } else if (e && e.network) {
        msg = "网络请求失败（HTTP " + e.status + "），请检查网络后重试";
    }
    console.log(TAG + " error: " + msg);
    sidebar.postMessage("error", { message: msg });
}

function pushPartsToSidebar() {
    sidebar.postMessage("video", {
        title: video.title,
        kind: video.type === "bangumi" ? "episodes" : "parts",
        parts: video.parts.map((p) => ({ page: p.page, part: p.part })),
        current: video.index
    });
}

function partLabel(index) {
    if (video.type === "bangumi") {
        return "第" + video.parts[index].page + "集";
    }
    return "第 " + (index + 1) + " P";
}

async function loadPart(index, token) {
    video.index = index;
    const cid = video.parts[index].cid;
    const label = partLabel(index);
    sidebar.postMessage("status", { text: "正在获取弹幕数据（" + label + "）…" });
    const xml = await biliDanmakuXml(cid);
    if (token !== loadToken) {
        return; // superseded by a newer load
    }
    pushToOverlay(xml);
    pushPartsToSidebar();
}

async function loadSource(text) {
    const token = invalidateCurrentLoad();
    if (core.status.idle) {
        sidebar.postMessage("error", { message: "请先播放本地视频，再加载弹幕" });
        return;
    }
    const bvid = extractBvid(text);
    if (bvid) {
        await loadBvid(bvid, token);
        return;
    }
    const link = extractBangumiLink(text);
    if (link) {
        await loadBangumiLink(link, token);
        return;
    }
    sidebar.postMessage("error", { message: "无法识别：请输入 BV 号/视频链接，或番剧 ep/ss/md 链接" });
}

async function loadBvid(bvid, token) {
    sidebar.postMessage("status", { text: "正在获取视频信息…" });
    try {
        const data = await biliApi("/x/web-interface/view", { bvid: bvid });
        if (token !== loadToken) {
            return;
        }
        video = {
            type: "video",
            bvid: bvid,
            title: data.title,
            parts: data.pages.map((p) => ({ page: p.page, part: p.part, cid: p.cid })),
            index: 0
        };
        console.log(TAG + " video: " + video.title + " (" + video.parts.length + " parts)");
        pushPartsToSidebar();
        await loadPart(0, token);
    } catch (e) {
        if (token !== loadToken) {
            return;
        }
        reportError(e);
    }
}

// ---------------------------------------------------------------------------
// M3: bangumi channel
// ---------------------------------------------------------------------------

function extractBangumiLink(text) {
    const t = (text || "").trim();
    let m = /bangumi\/play\/ep(\d+)/.exec(t);
    if (m) {
        return { type: "ep", id: m[1] };
    }
    m = /bangumi\/play\/ss(\d+)/.exec(t);
    if (m) {
        return { type: "ss", id: m[1] };
    }
    m = /bangumi\/media\/md(\d+)/.exec(t);
    if (m) {
        return { type: "md", id: m[1] };
    }
    return null;
}

// Persistent random buvid3: search/type API is walled without one (-412).
function getBuvid() {
    let buvid = null;
    try {
        buvid = preferences.get("buvid");
    } catch (e) { /* ignore */ }
    if (!buvid) {
        buvid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = Math.floor(Math.random() * 16);
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16).toUpperCase();
        });
        try {
            preferences.set("buvid", buvid);
            preferences.sync();
        } catch (e) { /* ignore */ }
    }
    return buvid;
}

async function searchBangumi(keyword, token) {
    keyword = (keyword || "").trim();
    if (!keyword) {
        sidebar.postMessage("error", { message: "请输入番剧名称" });
        return;
    }
    sidebar.postMessage("status", { text: "正在搜索「" + keyword + "」…" });
    try {
        const data = await biliApi("/x/web-interface/search/type",
            { search_type: "media_bangumi", keyword: keyword },
            {
                "Referer": "https://search.bilibili.com/",
                "Cookie": "buvid3=" + getBuvid()
            },
            () => token !== loadToken);
        if (data === null || token !== loadToken) {
            return;
        }
        const seasons = (data.result || []).map((r) => ({
            season_id: r.season_id,
            title: String(r.title || "").replace(/<[^>]*>/g, ""),
            year: r.pubtime ? new Date(r.pubtime * 1000).getFullYear() : null
        })).filter((s) => s.season_id);
        if (!seasons.length) {
            sidebar.postMessage("error", { message: "没有搜到相关番剧，换个关键词试试" });
            return;
        }
        console.log(TAG + " search: " + seasons.length + " seasons");
        sidebar.postMessage("seasons", { seasons: seasons });
        sidebar.postMessage("status", { text: "搜到 " + seasons.length + " 部番剧，请选择" });
    } catch (e) {
        if (token === loadToken) {
            reportError(e);
        }
    }
}

function requestBangumiSearch(keyword) {
    const normalizedKeyword = (keyword || "").trim();
    if (pendingSearch && pendingSearch.keyword === normalizedKeyword) {
        return pendingSearch.promise;
    }
    const token = invalidateCurrentLoad();
    const promise = searchBangumi(normalizedKeyword, token);
    pendingSearch = { keyword: normalizedKeyword, promise: promise };
    const clearPendingSearch = () => {
        if (pendingSearch && pendingSearch.promise === promise) {
            pendingSearch = null;
        }
    };
    promise.then(clearPendingSearch, clearPendingSearch);
    return promise;
}

async function loadSeasonById(seasonId, token, epId) {
    sidebar.postMessage("status", { text: "正在获取番剧信息…" });
    try {
        const params = epId ? { ep_id: epId } : { season_id: seasonId };
        const result = await biliApi("/pgc/view/web/season", params);
        if (token !== loadToken) {
            return;
        }
        const episodes = (result.episodes || []).slice();
        (result.section || []).forEach((section) => {
            if (section && Array.isArray(section.episodes)) {
                episodes.push(...section.episodes);
            }
        });
        if (!episodes.length) {
            throw { biliCode: -404, biliMessage: "该剧集无可播分集（可能地区受限）" };
        }
        video = {
            type: "bangumi",
            title: result.title,
            parts: episodes.map((e) => ({
                page: e.title,
                part: e.long_title,
                cid: e.cid,
                ep: e.id !== undefined ? e.id : e.ep_id,
                badge: e.badge
            })),
            index: -1
        };
        console.log(TAG + " season: " + video.title + " (" + video.parts.length + " episodes)");
        if (epId) {
            // Direct ep link: jump straight to that episode.
            let idx = video.parts.findIndex((p) => String(p.ep) === String(epId));
            if (idx < 0) {
                sidebar.postMessage("error", { message: "目标分集不在当前剧集列表中" });
                return;
            }
            pushPartsToSidebar();
            await loadPart(idx, token);
        } else if (video.parts.length === 1) {
            pushPartsToSidebar();
            await loadPart(0, token);
        } else {
            pushPartsToSidebar();
            sidebar.postMessage("status", { text: "「" + video.title + "」共 " + video.parts.length + " 集，请选择分集" });
        }
    } catch (e) {
        if (token === loadToken) {
            reportError(e);
        }
    }
}

async function loadBangumiLink(link, token) {
    try {
        if (link.type === "ep") {
            await loadSeasonById(null, token, link.id);
        } else if (link.type === "ss") {
            await loadSeasonById(link.id, token, null);
        } else {
            // md -> season_id via review API, then list episodes.
            sidebar.postMessage("status", { text: "正在解析 md 链接…" });
            const result = await biliApi("/pgc/review/user", { media_id: link.id });
            if (token !== loadToken) {
                return;
            }
            const seasonId = result && result.media && result.media.season_id;
            if (!seasonId) {
                throw { biliCode: -404, biliMessage: "该 md 链接找不到对应剧集" };
            }
            await loadSeasonById(String(seasonId), token, null);
        }
    } catch (e) {
        if (token === loadToken) {
            reportError(e);
        }
    }
}

function cancelOverlayStream() {
    streamPumpGeneration += 1;
    acknowledgeStreamChunk = null;
    pendingStream = null;
    currentStreamId = 0;
    lastPlaybackStateSentAt = 0;
    streamLoading = false;
}

function invalidateCurrentLoad() {
    loadToken += 1;
    pendingSearch = null;
    cancelOverlayStream();
    danmakuActive = false;
    if (overlayLoaded) {
        overlay.postMessage("clear", {});
    }
    return loadToken;
}

function startOverlayStream(payload) {
    const generation = ++streamPumpGeneration;
    let xml = payload.xml || "";
    let offset = 0;
    let nextChunkId = 0;
    let waitingForChunkId = null;

    sidebar.postMessage("status", { text: "弹幕数据已下载，正在传输…" });
    if (settings.enabled) {
        overlay.show();
    }
    overlay.setOpacity(settings.opacity / 100);
    readPlaybackState();
    overlay.postMessage("stream-start", {
        streamId: payload.streamId,
        title: payload.title,
        settings: payload.settings,
        playbackState: playbackStatePayload()
    });

    function pump() {
        if (generation !== streamPumpGeneration || !overlayLoaded ||
            payload.streamId !== currentStreamId) {
            return;
        }
        if (waitingForChunkId !== null) {
            return;
        }
        if (offset >= xml.length) {
            acknowledgeStreamChunk = null;
            overlay.postMessage("stream-end", { streamId: payload.streamId });
            xml = "";
            return;
        }
        const chunk = xml.slice(offset, offset + XML_CHUNK_SIZE);
        offset += chunk.length;
        const chunkId = nextChunkId;
        nextChunkId += 1;
        waitingForChunkId = chunkId;
        overlay.postMessage("stream-chunk", {
            streamId: payload.streamId,
            chunkId: chunkId,
            chunk: chunk
        });
    }
    acknowledgeStreamChunk = (streamId, chunkId) => {
        if (streamId !== payload.streamId || generation !== streamPumpGeneration ||
            chunkId !== waitingForChunkId) {
            return;
        }
        waitingForChunkId = null;
        pump();
    };
    pump();
}

function pushToOverlay(xml) {
    cancelOverlayStream();
    const payload = {
        streamId: ++nextStreamId,
        xml: xml,
        title: video.title,
        settings: overlaySettings()
    };
    currentStreamId = payload.streamId;
    danmakuActive = false;
    streamLoading = true;
    if (!overlayRequested) {
        overlay.loadFile("overlay/danmaku.html");
        overlayRequested = true;
    }
    // setClickable is deferred to overlay-ready; touching IINA's lazily created
    // overlay view from this thread aborts the app.
    if (overlayLoaded) {
        startOverlayStream(payload);
    } else {
        pendingStream = payload;
        sidebar.postMessage("status", { text: "弹幕数据已下载，等待渲染器…" });
    }
}

// Both sidebar and overlay webviews emit iina.plugin-overlay-loaded. Only
// install overlay listeners after this plugin has requested the overlay, then
// use a private ping/response handshake to identify the correct webview.
event.on("iina.plugin-overlay-loaded", () => {
    if (!overlayRequested) {
        return;
    }
    if (!overlayMessagesRegistered) {
        overlayMessagesRegistered = true;
        overlay.onMessage("overlay-ready", () => {
            overlayLoaded = true;
            overlay.setClickable(false);
            console.log(TAG + " overlay ready");
            if (pendingStream) {
                const stream = pendingStream;
                pendingStream = null;
                startOverlayStream(stream);
            } else if (danmakuActive && playbackState.time !== null) {
                sendPlaybackState(true);
            }
        });
        overlay.onMessage("stream-chunk-consumed", (data) => {
            if (data && acknowledgeStreamChunk) {
                acknowledgeStreamChunk(data.streamId, data.chunkId);
            }
        });
        overlay.onMessage("stream-state", (data) => {
            if (!data || data.streamId !== currentStreamId) {
                return;
            }
            const parsed = Number(data.parsed) || 0;
            const accepted = Number(data.accepted) || 0;
            if (data.phase === "parsing") {
                streamLoading = true;
                sidebar.postMessage("status", { text: "正在解析弹幕（已处理 " + parsed + " 条）…" });
            } else if (data.phase === "progress") {
                streamLoading = true;
                sidebar.postMessage("status", { text: "弹幕已可显示，正在继续解析（已处理 " + parsed + " 条）…" });
            } else if (data.phase === "available") {
                streamLoading = true;
                danmakuActive = true;
                sidebar.postMessage("status", { text: "弹幕已可显示，正在继续解析…" });
                pushPartsToSidebar();
            } else if (data.phase === "complete") {
                streamLoading = accepted > 0;
                danmakuActive = accepted > 0;
                sidebar.postMessage("status", {
                    text: "已加载「" + video.title + "」" + partLabel(video.index)
                });
            } else if (data.phase === "empty") {
                streamLoading = false;
                danmakuActive = false;
                sidebar.postMessage("status", { text: partLabel(video.index) + "暂无弹幕" });
            } else if (data.phase === "error") {
                streamLoading = false;
                danmakuActive = false;
                cancelOverlayStream();
                sidebar.postMessage("error", {
                    message: "弹幕渲染失败（" + (data.message || "未知原因") + "）"
                });
            }
        });
        overlay.onMessage("loaded", (data) => {
            if (data && data.streamId === currentStreamId) {
                console.log(TAG + " overlay available: " + data.title);
            }
        });
        overlay.onMessage("overlay-error", (data) => {
            if (!data || data.streamId !== currentStreamId) {
                return;
            }
            danmakuActive = false;
            cancelOverlayStream();
            console.log(TAG + " overlay error: " + (data && data.message));
            sidebar.postMessage("error", { message: "弹幕渲染失败（" + ((data && data.message) || "未知原因") + "）" });
        });
    }
    overlay.postMessage("ping", {});
});

// Playback sync: a revision denotes an explicit timeline discontinuity, so the
// overlay never needs to infer seeks from a time delta.
function readPlaybackState() {
    const position = Number(core.status.position);
    const rate = Number(core.status.speed);
    playbackState.time = Number.isFinite(position) ? position : playbackState.time;
    playbackState.paused = Boolean(core.status.paused);
    playbackState.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
}

function playbackStatePayload() {
    return {
        time: (playbackState.time === null ? 0 : playbackState.time) + settings.offset,
        paused: playbackState.paused,
        rate: playbackState.rate,
        seeking: playbackState.seeking,
        revision: playbackState.revision
    };
}

function sendPlaybackState(force) {
    if (!overlayLoaded || currentStreamId === 0 || !streamLoading) {
        return;
    }
    const now = Date.now();
    if (!force && now - lastPlaybackStateSentAt < TIME_UPDATE_INTERVAL) {
        return;
    }
    lastPlaybackStateSentAt = now;
    overlay.postMessage("playback-state", playbackStatePayload());
}

function updatePlaybackTime(time) {
    const nextTime = Number(time);
    if (!Number.isFinite(nextTime)) {
        return;
    }
    playbackState.time = nextTime;
    if (!playbackState.seeking) {
        sendPlaybackState(false);
    }
}

function updatePlaybackPause(paused) {
    playbackState.paused = Boolean(paused);
    sendPlaybackState(true);
}

function updatePlaybackRate(rate) {
    const nextRate = Number(rate);
    playbackState.rate = Number.isFinite(nextRate) && nextRate > 0 ? nextRate : 1;
    sendPlaybackState(true);
}

function updateSeekingState(seeking) {
    if (Boolean(seeking)) {
        playbackState.seeking = true;
        sendPlaybackState(true);
        return;
    }
    const position = Number(mpv.getNumber("time-pos"));
    if (Number.isFinite(position)) {
        playbackState.time = position;
    }
    playbackState.seeking = false;
    playbackState.revision += 1;
    lastPlaybackStateSentAt = 0;
    sendPlaybackState(true);
}

event.on("mpv.time-pos.changed", updatePlaybackTime);
event.on("mpv.pause.changed", updatePlaybackPause);
event.on("mpv.speed.changed", updatePlaybackRate);
event.on("mpv.seeking.changed", updateSeekingState);

event.on("mpv.window-scale.changed", () => {
    if (danmakuActive && overlayLoaded) {
        overlay.postMessage("resize", {});
    }
});

event.on("mpv.end-file", () => {
    invalidateCurrentLoad();
    playbackState.time = null;
});

console.log(TAG + " main entry loaded");
