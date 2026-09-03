// main.js — per-player entry.
//
// M1: sidebar panel lifecycle, main-entry menu, toggle state.
// M2: BV-source channel — view API -> parts -> cid -> danmaku XML -> overlay.
// M3: bangumi channel — search / ep-ss-md links -> seasons -> episodes -> cid.

const { core, console, menu, sidebar, overlay, event, mpv, http, global, preferences } = iina;

const TAG = "[bili-danmaku]";
const TOGGLE_SIDEBAR = "bili-danmaku:toggle-sidebar";

const BILI_HEADERS = {
    "Referer": "https://www.bilibili.com",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
};

// ---------------------------------------------------------------------------
// M1: sidebar toggle + menus
// ---------------------------------------------------------------------------

let sidebarVisible = false;

function showSidebar() {
    sidebar.show();
    sidebarVisible = true;
    console.log(TAG + " sidebar shown");
}

function hideSidebar() {
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

sidebar.loadFile("sidebar/index.html");
console.log(TAG + " sidebar file loaded");

sidebar.onMessage("sidebar-ready", () => {
    console.log(TAG + " sidebar ready");
    sidebar.postMessage("state", { loaded: false, status: "idle" });
});

const rootItem = menu.item("Bili Danmaku");
rootItem.addSubMenuItem(menu.item("Toggle Danmaku Panel", toggleSidebar));
menu.addItem(rootItem);

global.onMessage(TOGGLE_SIDEBAR, toggleSidebar);

// ---------------------------------------------------------------------------
// M2: Bilibili BV channel
// ---------------------------------------------------------------------------

// Current video source. XML itself is forwarded to the overlay, not cached.
let video = null; // { bvid, title, parts: [{page, part, cid}], index }
let overlayReady = false; // overlay.loadFile called
let overlayLoaded = false; // iina.plugin-overlay-loaded fired
let pendingXml = null; // load arrived before overlay webview was ready
let danmakuActive = false;
let loadToken = 0; // guards against overlapping loadSource calls

function extractBvid(text) {
    const m = /BV[a-zA-Z0-9]{10}/.exec((text || "").trim());
    return m ? m[0] : null;
}

async function biliApi(path, params, extraHeaders) {
    const headers = Object.assign({}, BILI_HEADERS, extraHeaders || {});
    const res = await http.get("https://api.bilibili.com" + path, {
        params: params,
        headers: headers,
        data: {}
    });
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
    sidebar.postMessage("status", { text: "正在加载" + label + "弹幕…" });
    const xml = await biliDanmakuXml(cid);
    if (token !== loadToken) {
        return; // superseded by a newer load
    }
    if (!/<d[\s>]/.test(xml)) {
        sidebar.postMessage("status", { text: label + "暂无弹幕" });
    } else {
        sidebar.postMessage("status", { text: "已加载「" + video.title + "」" + label });
    }
    pushToOverlay(xml);
    danmakuActive = true;
    pushPartsToSidebar();
}

async function loadSource(text) {
    const token = ++loadToken;
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
            });
        if (token !== loadToken) {
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

async function loadSeasonById(seasonId, token, epId) {
    sidebar.postMessage("status", { text: "正在获取番剧信息…" });
    try {
        const params = epId ? { ep_id: epId } : { season_id: seasonId };
        const result = await biliApi("/pgc/view/web/season", params);
        if (token !== loadToken) {
            return;
        }
        const episodes = result.episodes || [];
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
                ep: e.id,
                badge: e.badge
            })),
            index: -1
        };
        console.log(TAG + " season: " + video.title + " (" + video.parts.length + " episodes)");
        if (epId) {
            // Direct ep link: jump straight to that episode.
            let idx = video.parts.findIndex((p) => String(p.ep) === String(epId));
            if (idx < 0) {
                idx = 0;
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

function pushToOverlay(xml) {
    if (!overlayReady) {
        overlay.loadFile("overlay/danmaku.html");
        overlayReady = true;
    }
    overlay.setClickable(false);
    if (overlayLoaded) {
        overlay.show();
        overlay.postMessage("load", { xml: xml, title: video.title });
    } else {
        pendingXml = { xml: xml, title: video.title };
    }
}

// Sidebar -> plugin messages.
sidebar.onMessage("load-source", (data) => {
    loadSource(data && data.text);
});
sidebar.onMessage("search-bangumi", (data) => {
    const token = ++loadToken;
    searchBangumi(data && data.keyword, token);
});
sidebar.onMessage("select-season", (data) => {
    if (!data || !data.season_id) {
        return;
    }
    const token = ++loadToken;
    loadSeasonById(String(data.season_id), token, null);
});
sidebar.onMessage("select-part", (data) => {
    if (!video || !data) {
        return;
    }
    const index = data.index;
    if (index < 0 || index >= video.parts.length || index === video.index) {
        return;
    }
    const token = ++loadToken;
    loadPart(index, token).catch((e) => {
        if (token === loadToken) {
            reportError(e);
        }
    });
});

// Overlay lifecycle.
event.on("iina.plugin-overlay-loaded", () => {
    overlayLoaded = true;
    overlay.setClickable(false);
    console.log(TAG + " overlay loaded");
    if (pendingXml) {
        overlay.show();
        overlay.postMessage("load", pendingXml);
        pendingXml = null;
    }
});

overlay.onMessage("loaded", (data) => {
    console.log(TAG + " overlay rendered: " + (data && data.title));
});

// Playback sync: position, pause, window resize, file end.
event.on("mpv.time-pos.changed", (t) => {
    if (danmakuActive && overlayLoaded) {
        overlay.postMessage("time", { time: t });
    }
});

event.on("mpv.pause.changed", (paused) => {
    if (danmakuActive && overlayLoaded) {
        overlay.postMessage("pause", { paused: paused });
    }
});

event.on("mpv.window-scale.changed", () => {
    if (danmakuActive && overlayLoaded) {
        overlay.postMessage("resize", {});
    }
});

event.on("mpv.end-file", () => {
    danmakuActive = false;
    pendingXml = null;
    if (overlayLoaded) {
        overlay.postMessage("clear", {});
    }
});

console.log(TAG + " main entry loaded");
