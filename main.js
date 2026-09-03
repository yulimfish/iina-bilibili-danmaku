// main.js — per-player entry.
//
// M1: sidebar panel lifecycle, main-entry menu, toggle state.
// M2: BV-source channel — view API -> parts -> cid -> danmaku XML -> overlay.

const { core, console, menu, sidebar, overlay, event, mpv, http, global } = iina;

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

async function biliApi(path, params) {
    const res = await http.get("https://api.bilibili.com" + path, {
        params: params,
        headers: BILI_HEADERS,
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
    return body.data;
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
        parts: video.parts.map((p) => ({ page: p.page, part: p.part })),
        current: video.index
    });
}

async function loadPart(index, token) {
    video.index = index;
    const cid = video.parts[index].cid;
    sidebar.postMessage("status", { text: "正在加载第 " + (index + 1) + " P 弹幕…" });
    const xml = await biliDanmakuXml(cid);
    if (token !== loadToken) {
        return; // superseded by a newer load
    }
    if (!/<d[\s>]/.test(xml)) {
        sidebar.postMessage("status", { text: "该分 P 暂无弹幕" });
    } else {
        sidebar.postMessage("status", { text: "已加载「" + video.title + "」第 " + (index + 1) + " P" });
    }
    pushToOverlay(xml);
    danmakuActive = true;
    pushPartsToSidebar();
}

async function loadSource(text) {
    const token = ++loadToken;
    const bvid = extractBvid(text);
    if (!bvid) {
        sidebar.postMessage("error", { message: "无法识别 BV 号，请输入 BV 号或含 BV 号的视频链接" });
        return;
    }
    if (core.status.idle) {
        sidebar.postMessage("error", { message: "请先播放本地视频，再加载弹幕" });
        return;
    }
    sidebar.postMessage("status", { text: "正在获取视频信息…" });
    try {
        const data = await biliApi("/x/web-interface/view", { bvid: bvid });
        if (token !== loadToken) {
            return;
        }
        video = {
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
