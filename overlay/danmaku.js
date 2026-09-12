// danmaku.js — runs inside the overlay WKWebView (no iina API here,
// only iina.postMessage / iina.onMessage to talk to main.js).
// Renders Bilibili XML via CommentCoreLibrary, synced to mpv time-pos.

let cm = null;
let provider = null;
let lastTime = 0;
let cachedXml = null;
let cachedTitle = "";

// M4 overlay-side settings (mirrors main.js, applied on load / live update).
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
    applyFilter();
    resize();
    cm.start();
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
    const w = (stage && stage.offsetWidth) || window.innerWidth || ov.speed;
    cm.options.scroll.scale = w / ov.speed;
    cm.setBounds();
}

// Unify per-comment size to the user-chosen font size.
function scaledXml(xml, size) {
    return xml.replace(/(<d p="[\d.]+,\d+,)\d+(,)/g, "$1" + size + "$2");
}

function buildProvider() {
    if (provider) {
        try {
            provider.destroy();
        } catch (e) { /* ignore */ }
    }
    provider = new CommentProvider();
    cm.clear();
    provider.addTarget(cm);
    provider.addStaticSource(
        Promise.resolve(scaledXml(cachedXml, ov.fontSize)),
        CommentProvider.SOURCE_TEXT).addParser(
        new BilibiliFormat.TextParser(),
        CommentProvider.SOURCE_TEXT);
    provider.start().then(() => {
        cm.start();
        cm.time(Math.floor(lastTime * 1000));
        iina.postMessage("loaded", { title: cachedTitle });
    }).catch((e) => {
        iina.postMessage("overlay-error", { message: String((e && e.message) || e) });
    });
}

iina.onMessage("load", (data) => {
    ensureCM();
    cachedXml = data.xml;
    cachedTitle = data.title || "";
    lastTime = 0;
    if (data.settings) {
        ov.speed = data.settings.speed || ov.speed;
        ov.fontSize = data.settings.fontSize || ov.fontSize;
        ov.showTop = data.settings.showTop !== false;
        ov.showBottom = data.settings.showBottom !== false;
    }
    applyFilter();
    resize();
    buildProvider();
});

iina.onMessage("filter", (d) => {
    ov.showTop = d.showTop !== false;
    ov.showBottom = d.showBottom !== false;
    applyFilter();
});

iina.onMessage("style", (d) => {
    let needReload = false;
    if (d.speed && d.speed !== ov.speed) {
        ov.speed = d.speed;
        resize();
    }
    if (d.fontSize && d.fontSize !== ov.fontSize) {
        ov.fontSize = d.fontSize;
        needReload = true;
    }
    if (needReload && cachedXml && cm) {
        buildProvider();
    }
});

iina.onMessage("time", (t) => {
    if (!cm) {
        return;
    }
    // Seek jump: drop on-screen comments to avoid stale ones lingering.
    if (Math.abs(lastTime - t.time) > 5.5) {
        cm.clear();
    }
    lastTime = t.time;
    cm.time(Math.floor(t.time * 1000));
});

iina.onMessage("pause", (t) => {
    if (!cm) {
        return;
    }
    if (t.paused) {
        cm.stop();
    } else {
        cm.start();
    }
});

iina.onMessage("resize", resize);

iina.onMessage("clear", () => {
    lastTime = 0;
    if (cm) {
        cm.clear();
    }
});

document.addEventListener("visibilitychange", () => {
    if (cm && cm.setHidden) {
        cm.setHidden(document.hidden);
    }
});
window.addEventListener("resize", resize);
