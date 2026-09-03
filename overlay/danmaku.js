// danmaku.js — runs inside the overlay WKWebView (no iina API here,
// only iina.postMessage / iina.onMessage to talk to main.js).
// Renders Bilibili XML via CommentCoreLibrary, synced to mpv time-pos.

let cm = null;
let provider = null;
let lastTime = 0;

// Baseline stage width CCL scroll speed is tuned against.
const BASE_WIDTH = 680;

function ensureCM() {
    if (cm) {
        return;
    }
    cm = new CommentManager(document.getElementById("commentCanvas"));
    cm.init();
    // Drop advanced / code / BAS comments (mode 7/8/9).
    cm.filter.allowUnknownTypes = false;
    resize();
    cm.start();
}

function resize() {
    if (!cm) {
        return;
    }
    const stage = document.getElementById("stage");
    const w = (stage && stage.offsetWidth) || window.innerWidth || BASE_WIDTH;
    cm.options.scroll.scale = w / BASE_WIDTH;
    cm.setBounds();
}

iina.onMessage("load", (data) => {
    ensureCM();
    if (provider) {
        try {
            provider.destroy();
        } catch (e) { /* ignore */ }
    }
    provider = new CommentProvider();
    cm.clear();
    provider.addTarget(cm);
    provider.addStaticSource(
        Promise.resolve(data.xml),
        CommentProvider.SOURCE_TEXT).addParser(
        new BilibiliFormat.TextParser(),
        CommentProvider.SOURCE_TEXT);
    provider.start().then(() => {
        cm.start();
        lastTime = 0;
        iina.postMessage("loaded", { title: data.title });
    });
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
