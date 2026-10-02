// main.js — per-player entry.
//
// M1: sidebar panel lifecycle, main-entry menu, toggle state.
// M2: BV-source channel — view API -> parts -> cid -> danmaku XML -> overlay.
// M3: bangumi channel — search / ep-ss-md links -> seasons -> episodes -> cid.
// M4: danmaku controls — toggle / font / opacity / speed / offset / clear.

const { core, console, menu, sidebar, overlay, event, mpv, http, file, preferences, utils } = iina;

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
    sidebar.onMessage("load-suggestion", (data) => {
        const candidate = data && data.candidate;
        const partIndex = data && data.partIndex;
        const generation = data && data.generation;
        if (!candidate || !Number.isInteger(generation) || generation !== fileGeneration ||
            !Number.isInteger(partIndex) || partIndex < 0) {
            return;
        }
        if (candidate.kind === "bangumi" && candidate.season_id) {
            const episodes = candidateEpisodes(candidate);
            if (partIndex >= episodes.length || !episodes[partIndex]) {
                return;
            }
            const loadState = invalidateCurrentLoad();
            return loadSeasonById(String(candidate.season_id), loadState, null, null, partIndex);
        }
        if (candidate.kind === "video" && candidate.bvid) {
            const pages = candidatePages(candidate);
            if (partIndex >= pages.length || !pages[partIndex]) {
                return;
            }
            const loadState = invalidateCurrentLoad();
            return loadBvid(candidate.bvid, loadState, null, partIndex);
        }
    });
    sidebar.onMessage("search-bangumi", (data) => {
        return requestBangumiSearch(data && data.keyword);
    });
    sidebar.onMessage("search-video", (data) => {
        return requestSourceSearch("video", data && data.keyword);
    });
    sidebar.onMessage("select-season", (data) => {
        if (!data || !data.season_id || data.generation !== fileGeneration) {
            return;
        }
        const loadState = invalidateCurrentLoad();
        return loadSeasonById(String(data.season_id), loadState, null);
    });
    sidebar.onMessage("select-part", (data) => {
        if (!video || !data) {
            return;
        }
        const index = data.index;
        if (index < 0 || index >= video.parts.length || index === video.index) {
            return;
        }
        const loadState = invalidateCurrentLoad();
        return loadPart(index, loadState).catch((e) => {
            if (isCurrentLoad(loadState)) {
                reportError(e);
            }
        });
    });

    sidebar.onMessage("sidebar-ready", () => {
        console.log(TAG + " sidebar ready");
        postFontList();
        sidebar.postMessage("state", { loaded: false, status: "idle" });
        sidebar.postMessage("settings", { settings: settings });
        postAuthState();
        if (qrState) sidebar.postMessage("auth-qr", qrState);
        sidebar.postMessage("history-progress", historyProgress);
        if (currentFileContextState) {
            sidebar.postMessage("file-context", currentFileContextState);
        }
        if (currentSuggestionsState) {
            sidebar.postMessage("suggestions", currentSuggestionsState);
        }
    });
    sidebar.onMessage("update-settings", (data) => {
        if (data && data.patch) {
            applySettings(data.patch);
        }
    });
    sidebar.onMessage("auth-cookie", (data) => loginWithCookie(data && data.cookie));
    sidebar.onMessage("auth-qr-start", startQrLogin);
    sidebar.onMessage("auth-qr-cancel", () => cancelQrLogin(true));
    sidebar.onMessage("auth-logout", logout);
    sidebar.onMessage("history-cancel", () => cancelHistoryBackfill("已取消回补，保留已获取的弹幕"));
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
let currentStreamMetadata = null;
let autoHudNotifiedStreamId = 0;
let streamPumpGeneration = 0;
let acknowledgeStreamChunk = null;
let danmakuActive = false;
let streamLoading = false;
let loadToken = 0; // guards against overlapping adopted source loads
let fileGeneration = 0; // invalidates work from an older local file
let searchGeneration = 0; // invalidates stale search results without clearing danmaku
let currentFileIdentity = null;
let currentFileContextState = null;
let currentSuggestionsState = null;
const pendingSearches = new Map();
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
const searchCache = new Map();
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
    fontFamily: "system", // preset id or installed font family name
    strokeWidth: 1, // px, 0-3 in half-pixel steps
    strokeColor: "#000000", // text outline color, #RRGGBB
    opacity: 100, // 0-100
    speed: 680, // CCL scroll baseline; larger = faster
    offset: 0, // seconds added to playback position
    autoLoadBangumi: false,
    autoLoadVideo: false
};

const FONT_FAMILY_SANITIZER = /^[^;{}()<>\\",'\r\n]+$/;
const FONT_FAMILY_MAX_LENGTH = 60;

// SESSDATA is a URL-encoded token; reject anything that would break the
// Cookie header instead of escaping it silently.
const SESSDATA_SANITIZER = /^[^;{}()<>\\",'\s]+$/;
const SESSDATA_MIN_LENGTH = 5;
const SESSDATA_MAX_LENGTH = 300;
const SESSDATA_PREFIX = /^SESSDATA=/i;

function sanitizeSessdata(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim().replace(SESSDATA_PREFIX, "").trim().replace(/,/g, "%2C");
    if (trimmed.length < SESSDATA_MIN_LENGTH || trimmed.length > SESSDATA_MAX_LENGTH ||
        !SESSDATA_SANITIZER.test(trimmed)) {
        return "";
    }
    return trimmed;
}

let settings = Object.assign({}, DEFAULT_SETTINGS);
let fonts = null; // installed font families; null = enumeration unavailable
const AUTH_SERVICE = "bilibili";
const AUTH_ACCOUNT = "SESSDATA";
let sessdata = ""; // Main-entry memory only; never included in settings/messages.
let legacySessdata = ""; // Retain the old preference until migration and cleanup both succeed.
let legacyPreferencePendingClear = false;
let authGeneration = 0;
let credentialDeletion = null;
let credentialStored = false;
let accountInfo = null;
let authState = { status: "anonymous", loggedIn: false, account: null, message: "未登录 · 匿名模式" };
let qrState = null;
let qrJob = null;
let historyJob = null;
let historyProgress = { active: false, text: "登录后加载来源可回补历史弹幕", completed: 0, total: 0, added: 0 };

// Returns a trimmed, injection-safe font family name, or null when invalid.
function sanitizeFontFamily(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > FONT_FAMILY_MAX_LENGTH ||
        !FONT_FAMILY_SANITIZER.test(trimmed) || /url\(/i.test(trimmed)) {
        return null;
    }
    return trimmed;
}

function normalizeSettings(candidate) {
    const normalized = Object.assign({}, DEFAULT_SETTINGS);
    const ranges = { fontSize: [18, 36], opacity: [0, 100], speed: [200, 1200], offset: [-30, 30], strokeWidth: [0, 3] };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return normalized;
    }
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
            return;
        }
        const value = candidate[key];
        if (key === "fontFamily") {
            const family = sanitizeFontFamily(value);
            if (family !== null) {
                normalized[key] = family;
            }
        } else if (key === "strokeColor") {
            if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
                normalized[key] = value;
            }
        } else if (typeof DEFAULT_SETTINGS[key] === "boolean") {
            if (typeof value === "boolean") {
                normalized[key] = value;
            }
        } else if (Number.isFinite(value)) {
            const range = ranges[key];
            normalized[key] = Math.max(range[0], Math.min(range[1], value));
            if (key === "strokeWidth") {
                normalized[key] = Math.round(normalized[key] * 2) / 2;
            }
        }
    });
    return normalized;
}

function loadSettings() {
    try {
        const stored = preferences.get("settings");
        settings = normalizeSettings(stored);
        loadCredential(stored);
        // Rewrite the plist when stored settings predate new keys or normalize
        // corrected a value, so updates migrate without any sidebar interaction.
        const isPlain = Boolean(stored) && typeof stored === "object" && !Array.isArray(stored);
        const needsMigration = !isPlain ||
            !Object.prototype.hasOwnProperty.call(stored, "fontFamily") ||
            !Object.prototype.hasOwnProperty.call(stored, "strokeColor") ||
            Object.prototype.hasOwnProperty.call(stored, "sessdata") ||
            Object.keys(DEFAULT_SETTINGS).some((key) => stored[key] !== settings[key]);
        if (needsMigration && !saveSettings() && legacyPreferencePendingClear) {
            setAuthState("error", "钥匙串迁移已完成，但旧版设置中的 SESSDATA 尚未清除；请稍后退出登录重试");
        }
    } catch (e) { /* ignore */ }
}

function saveSettings() {
    try {
        // Preserve an old token when Keychain migration failed; once migration
        // succeeded, retain it in memory until the preference rewrite succeeds.
        preferences.set("settings", legacySessdata && !legacyPreferencePendingClear
            ? Object.assign({}, settings, { sessdata: legacySessdata }) : settings);
        preferences.sync();
        if (legacyPreferencePendingClear) {
            legacySessdata = "";
            legacyPreferencePendingClear = false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

function overlaySettings() {
    return {
        speed: settings.speed,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        strokeWidth: settings.strokeWidth,
        strokeColor: settings.strokeColor,
        showTop: settings.showTop,
        showBottom: settings.showBottom
    };
}

function applySettings(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return;
    }
    settings = normalizeSettings(Object.assign(Object.create(null), settings, patch));
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
        if ("speed" in patch || "fontSize" in patch || "fontFamily" in patch ||
            "strokeWidth" in patch || "strokeColor" in patch) {
            overlay.postMessage("style", overlaySettings());
        }
        if ("offset" in patch) {
            sendPlaybackState(true);
        }
    }
    sidebar.postMessage("settings", { settings: settings });
}

// Credentials never travel through ordinary settings or overlay messages.
function readKeychain() {
    const read = utils.keychainRead || utils.keyChainRead;
    return typeof read === "function" ? read.call(utils, AUTH_SERVICE, AUTH_ACCOUNT) : false;
}

function writeKeychain(value) {
    const write = utils.keychainWrite || utils.keyChainWrite;
    try {
        return typeof write === "function" && write.call(utils, AUTH_SERVICE, AUTH_ACCOUNT, value) === true &&
            readKeychain() === value;
    } catch (e) {
        return false;
    }
}

function postAuthState() {
    sidebar.postMessage("auth-state", authState);
}

function setAuthState(status, message) {
    authState = { status: status, loggedIn: Boolean(sessdata), canLogout: credentialStored || Boolean(legacySessdata),
        account: accountInfo, message: message };
    postAuthState();
}

function accountProfile(data) {
    if (!data || typeof data !== "object") return null;
    const numeric = (value) => (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
        ? Number(value) : null;
    const vip = data.vip && typeof data.vip === "object" ? data.vip : {};
    const label = data.vip_label && typeof data.vip_label === "object" ? data.vip_label :
        vip.label && typeof vip.label === "object" ? vip.label : {};
    const uname = typeof data.uname === "string" ? data.uname.trim().slice(0, 80) : "";
    const vipStatus = numeric(data.vipStatus) !== null ? numeric(data.vipStatus) : numeric(vip.status);
    const vipType = numeric(data.vipType) !== null ? numeric(data.vipType) : numeric(vip.type);
    const due = Number(data.vipDueDate !== undefined ? data.vipDueDate : vip.due_date);
    return {
        uname: uname || "B 站用户",
        vipStatus: vipStatus,
        vipType: vipType,
        vipDueDate: Number.isFinite(due) && due > 0 ? due : null,
        vipLabel: typeof label.text === "string" ? label.text.trim().slice(0, 40) : ""
    };
}

function loadCredential(stored) {
    legacySessdata = sanitizeSessdata(stored && stored.sessdata);
    let saved = "";
    try { saved = sanitizeSessdata(readKeychain()); } catch (e) { /* unavailable */ }
    if (!saved && legacySessdata) {
        if (writeKeychain(legacySessdata)) {
            saved = legacySessdata;
            legacyPreferencePendingClear = true;
        }
        else {
            setAuthState("error", "旧登录态暂未迁入钥匙串；保留原设置，当前使用匿名模式");
            return;
        }
    }
    if (!saved) return;
    if (legacySessdata) legacyPreferencePendingClear = true;
    credentialStored = true;
    const generation = authGeneration;
    setAuthState("checking", "正在验证钥匙串中的登录态…");
    validateCredential(saved).then((data) => {
        if (generation === authGeneration) {
            sessdata = saved;
            accountInfo = accountProfile(data);
            setAuthState("authenticated", legacySessdata
                ? "已登录；旧版设置中的 SESSDATA 尚未清除，退出登录后可重试清理"
                : "已登录，加载来源时将限速补充历史弹幕");
        }
    }).catch((e) => {
        if (generation === authGeneration) {
            cancelHistoryBackfill("启动登录验证失败，历史回补已停止", false);
            sessdata = "";
            accountInfo = null;
            setAuthState(e && e.biliCode === -101 ? "expired" : "error", authErrorMessage(e));
        }
    });
}

function cookieSessdata(raw) {
    if (typeof raw !== "string" || raw.length > 16384 || /[\r\n\x00]/.test(raw)) return "";
    const match = /(?:^|;)\s*SESSDATA\s*=\s*([^;]*)/i.exec(raw);
    if (match) return sanitizeSessdata(match[1]);
    if (raw.indexOf(";") >= 0 || /^[a-z_][\w]*\s*=/i.test(raw.trim())) return "";
    return sanitizeSessdata(raw);
}

async function validateCredential(value) {
    const data = await biliApi("/x/web-interface/nav", {}, { Cookie: "SESSDATA=" + value });
    if (!data || data.isLogin !== true) throw { biliCode: -101 };
    return data;
}

function authErrorMessage(e) {
    if (e && e.keychain) return "钥匙串保存失败，未启用新登录态；请检查系统授权后重试";
    if (e && e.biliCode === -101) return "登录态已失效，已回退匿名模式；请重新扫码或粘贴 Cookie";
    if (e && (e.biliCode === -412 || e.status === 412 || e.status === 429)) {
        return "登录请求受限，请稍后重试；匿名加载仍可使用";
    }
    return "登录验证失败，请重试；匿名加载仍可使用";
}

async function acceptCredential(value, generation) {
    const data = await validateCredential(value);
    if (credentialDeletion) await credentialDeletion;
    if (generation !== authGeneration) return false;
    if (!writeKeychain(value)) throw { keychain: true };
    sessdata = value;
    accountInfo = accountProfile(data);
    credentialStored = true;
    if (legacySessdata) legacyPreferencePendingClear = true;
    saveSettings();
    setAuthState("authenticated", legacySessdata
        ? "已登录；旧版设置中的 SESSDATA 尚未清除，退出登录后可重试清理"
        : "已登录，加载来源时将限速补充历史弹幕");
    return true;
}

async function loginWithCookie(raw) {
    cancelQrLogin(false);
    cancelHistoryBackfill("登录操作已开始，已停止历史回补");
    const generation = ++authGeneration;
    const value = cookieSessdata(raw);
    if (!value) {
        setAuthState("error", "Cookie 中未找到有效 SESSDATA，请检查粘贴内容");
        return;
    }
    setAuthState("checking", "正在验证 Cookie…");
    try {
        await acceptCredential(value, generation);
    } catch (e) {
        if (generation === authGeneration) setAuthState("error", authErrorMessage(e));
    }
}

function postQr(status, message, url) {
    qrState = { status: status, message: message };
    if (url) qrState.url = url;
    sidebar.postMessage("auth-qr", qrState);
}

function cancelQrLogin(notify) {
    if (qrJob) {
        clearTimeout(qrJob.timer);
        qrJob = null;
    }
    if (notify) {
        cancelHistoryBackfill("扫码已取消，历史回补已停止");
        authGeneration += 1;
        postQr("cancelled", "已取消扫码");
        setAuthState(sessdata ? "authenticated" : "anonymous", sessdata ? "已登录" : "未登录 · 匿名模式");
    }
}

async function passportApi(action, params) {
    const res = await http.get("https://passport.bilibili.com/x/passport-login/web/qrcode/" + action, {
        params: params || {}, headers: BILI_HEADERS, data: {}
    });
    if (!res || res.statusCode !== 200) throw { status: res && res.statusCode };
    const body = JSON.parse(res.text);
    if (body.code !== 0 || !body.data) throw { biliCode: body.code };
    return body.data;
}

async function startQrLogin() {
    cancelQrLogin(false);
    cancelHistoryBackfill("扫码登录已开始，已停止历史回补");
    const job = { generation: ++authGeneration, timer: null, polls: 0, started: Date.now() };
    qrJob = job;
    postQr("loading", "正在生成二维码…");
    try {
        const data = await passportApi("generate");
        if (qrJob !== job) return;
        if (!/^[a-zA-Z0-9]{32}$/.test(data.qrcode_key || "") || typeof data.url !== "string" ||
            !/^https:\/\/account\.bilibili\.com\/h5\/account-h5\/auth\/scan-web\?[^\s"'<>\\]+$/.test(data.url)) {
            throw { invalidQr: true };
        }
        job.key = data.qrcode_key;
        job.url = data.url;
        postQr("waiting", "请用哔哩哔哩 App 扫码，并在手机上确认", job.url);
        void pollQrLogin(job);
    } catch (e) {
        if (qrJob !== job) return;
        qrJob = null;
        postQr("error", "二维码生成失败，请刷新重试");
    }
}

async function pollQrLogin(job) {
    if (qrJob !== job || job.generation !== authGeneration) return;
    if (++job.polls > 60 || Date.now() - job.started >= 180000) {
        qrJob = null;
        postQr("expired", "二维码已过期，请刷新");
        return;
    }
    try {
        const data = await passportApi("poll", { qrcode_key: job.key });
        if (qrJob !== job || job.generation !== authGeneration) return;
        if (data.code === 86101 || data.code === 86090) {
            postQr(data.code === 86090 ? "scanned" : "waiting",
                data.code === 86090 ? "已扫码，请在手机上确认登录" : "等待扫码…", job.url);
            job.timer = setTimeout(() => { void pollQrLogin(job); }, 3000);
            return;
        }
        if (data.code === 86038) {
            qrJob = null;
            postQr("expired", "二维码已过期，请刷新");
            return;
        }
        if (data.code !== 0) throw { biliCode: data.code };
        postQr("loading", "扫码已确认，正在验证登录态…");
        const value = await exchangeQrTicket(data.url, () => qrJob !== job || job.generation !== authGeneration);
        if (qrJob !== job || job.generation !== authGeneration) return;
        cancelHistoryBackfill("登录态已更换，已停止历史回补");
        if (await acceptCredential(value, job.generation)) {
            qrJob = null;
            postQr("success", "登录成功，凭据已保存到 macOS 钥匙串");
        }
    } catch (e) {
        if (qrJob !== job || job.generation !== authGeneration) return;
        qrJob = null;
        postQr("error", "扫码验证失败，可刷新二维码或粘贴 Cookie");
        setAuthState("error", authErrorMessage(e));
    }
}

// IINA logs exec argv, so the one-time ticket must stay in a private config.
// No SESSDATA is ever written to this file. Redirects are allowlisted per hop.
let nextAuthTempId = 0;
async function exchangeQrTicket(url, isStale) {
    const stale = isStale || (() => false);
    if (typeof url !== "string" || url.length > 4096 || /[\s"'<>\\]/.test(url)) throw { invalidTicket: true };
    if (/^https:\/\/(?:www\.bilibili\.com|passport\.bilibili\.com)\//.test(url)) {
        const old = /[?&]SESSDATA=([^&#]*)/i.exec(url);
        if (old) {
            const value = sanitizeSessdata(decodeURIComponent(old[1]));
            if (value) return value;
        }
    }
    for (let hop = 0; hop < 3; hop += 1) {
        if (stale()) throw { cancelled: true };
        if (!/^https:\/\/(?:passport\.biligame\.com|passport\.bilibili\.com)\/x\/passport-login\/web\/crossDomain\?[A-Za-z0-9%&=_+.~-]+$/.test(url) ||
            !/[?&]ticket=[^&]+/.test(url)) throw { invalidTicket: true };
        const directory = "@tmp/bili-auth-" + Date.now() + "-" + (++nextAuthTempId) + "-" + Math.random().toString(36).slice(2);
        const config = directory + "/curl.conf";
        let madeDirectory = false;
        try {
            const created = await utils.exec("/bin/mkdir", ["-m", "700", utils.resolvePath(directory)]);
            if (!created || created.status !== 0) throw { authTemp: true };
            madeDirectory = true;
            if (stale()) throw { cancelled: true };
            file.write(config, 'url = "' + url + '"\n');
            const mode = await utils.exec("/bin/chmod", ["600", utils.resolvePath(config)]);
            if (!mode || mode.status !== 0) throw { authTemp: true };
            if (stale()) throw { cancelled: true };
            const result = await utils.exec("/usr/bin/curl", ["-q", "--config", utils.resolvePath(config),
                "--silent", "--show-error", "--proto", "=https", "--max-time", "15", "--max-redirs", "0",
                "--user-agent", BILI_HEADERS["User-Agent"], "--referer", BILI_HEADERS.Referer,
                "--dump-header", "-", "--output", "/dev/null"]);
            if (stale()) throw { cancelled: true };
            if (!result || result.status !== 0 || typeof result.stdout !== "string") throw { ticketRequest: true };
            const headers = result.stdout;
            const statusMatches = Array.from(headers.matchAll(/(?:^|\n)HTTP\/\S+\s+(\d{3})/g));
            const status = statusMatches.length ? Number(statusMatches[statusMatches.length - 1][1]) : 0;
            if (status < 200 || status >= 400) throw { status: status };
            const cookie = /(?:^|\n)set-cookie:\s*SESSDATA=([^;\r\n]*)/i.exec(headers);
            if (cookie) {
                const value = sanitizeSessdata(cookie[1]);
                if (value) return value;
            }
            const location = /(?:^|\n)location:\s*([^\r\n]+)/i.exec(headers);
            if (status >= 300 && location) {
                url = location[1].trim();
                continue;
            }
            throw { missingCredential: true };
        } finally {
            if (madeDirectory) {
                try { file.delete(config); } catch (e) { /* best-effort */ }
                try { file.delete(directory); } catch (e) { /* best-effort */ }
            }
        }
    }
    throw { ticketRedirects: true };
}

async function logout() {
    cancelQrLogin(false);
    cancelHistoryBackfill("已退出登录，保留当前弹幕");
    postQr("cancelled", "已退出登录");
    const generation = ++authGeneration;
    sessdata = "";
    accountInfo = null;
    const hadLegacyPreference = Boolean(legacySessdata);
    if (hadLegacyPreference) legacyPreferencePendingClear = true;
    if (!saveSettings() && hadLegacyPreference) {
        setAuthState("error", "退出未完成：旧版设置中的 SESSDATA 未能清除；请重试退出登录");
        return;
    }
    const previousDeletion = credentialDeletion;
    const deletion = (async () => {
        if (previousDeletion) await previousDeletion;
        return await utils.exec("/usr/bin/security", ["delete-generic-password", "-s",
            "cn.waterflames.iina-bilibili-danmaku - " + AUTH_SERVICE, "-a", AUTH_ACCOUNT]);
    })();
    credentialDeletion = deletion;
    try {
        const result = await deletion;
        if (!result || (result.status !== 0 && result.status !== 44)) throw { keychain: true };
        credentialStored = false;
        if (generation === authGeneration) setAuthState("anonymous", "已退出 · 未登录，当前使用匿名模式");
    } catch (e) {
        credentialStored = true;
        if (generation === authGeneration) setAuthState("error", "已切换匿名模式，但钥匙串删除失败；请在钥匙串访问中删除插件登录项");
    } finally {
        if (credentialDeletion === deletion) credentialDeletion = null;
    }
}

loadSettings();

function postFontList() {
    sidebar.postMessage("font-list", { fonts: fonts });
}

const FONT_ENUM_CAP = 1000;
const FONT_CACHE_KEY = "fontFamilies";
const FONT_DIAG_KEY = "fontEnumDiag";
// Ordered strategies after the in-process bridge probe: osascript +
// NSFontManager + ObjC.deepUnwrap is verified to list every installed family
// on this platform; the CoreText variant is kept as a second exec fallback.
const FONT_ENUM_ATTEMPTS = [
    {
        name: "osascript-nsfontmanager",
        jxa: "ObjC.import('AppKit'); JSON.stringify(Array.from(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies) || []));"
    },
    {
        name: "osascript-coretext",
        jxa: "ObjC.import('CoreText'); JSON.stringify(Array.from(ObjC.deepUnwrap($.CTFontManagerCopyAvailableFontFamilyNames()) || []));"
    }
];

function cleanFontList(raw) {
    if (!Array.isArray(raw)) {
        return null;
    }
    const cleaned = [];
    const seen = new Set();
    for (const name of raw) {
        const family = sanitizeFontFamily(name);
        if (family !== null && !seen.has(family)) {
            seen.add(family);
            cleaned.push(family);
        }
        if (cleaned.length >= FONT_ENUM_CAP) {
            break;
        }
    }
    return cleaned.length > 0 ? cleaned : null;
}

function parseFontStdout(stdout) {
    if (typeof stdout !== "string" || !stdout.trim()) {
        return null;
    }
    let families;
    try {
        families = JSON.parse(stdout);
    } catch (e) {
        return null;
    }
    return cleanFontList(families);
}

function loadFontCache() {
    try {
        return cleanFontList(preferences.get(FONT_CACHE_KEY));
    } catch (e) {
        return null;
    }
}

function persistFontDiagnostics(diag, cacheFonts) {
    try {
        if (cacheFonts) {
            preferences.set(FONT_CACHE_KEY, cacheFonts);
        }
        preferences.set(FONT_DIAG_KEY, diag);
        preferences.sync();
    } catch (e) { /* ignore */ }
}

async function enumerateSystemFonts() {
    const diag = { objcBridge: null, attempts: [], final: null, count: 0 };
    // Probe 0: IINA evaluates plugins in JavaScriptCore; if the ObjC bridge
    // happens to be enabled there we can enumerate in-process and skip exec.
    try {
        if (typeof $ === "undefined" || typeof ObjC === "undefined") {
            diag.objcBridge = "absent";
        } else {
            ObjC.import("AppKit");
            const cleaned = cleanFontList(
                ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies)
            );
            if (cleaned) {
                fonts = cleaned;
                diag.objcBridge = "ok";
                diag.final = "bridge";
                diag.count = fonts.length;
                persistFontDiagnostics(diag, fonts);
                console.log(TAG + " font enum via in-process bridge count=" + fonts.length);
                postFontList();
                return;
            }
            diag.objcBridge = "empty";
        }
    } catch (e) {
        diag.objcBridge = "error: " + String(e).slice(0, 120);
    }
    for (const attempt of FONT_ENUM_ATTEMPTS) {
        try {
            const result = await utils.exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", attempt.jxa]);
            const stdout = result && result.stdout;
            const cleaned = parseFontStdout(stdout);
            diag.attempts.push({
                name: attempt.name,
                status: result && result.status,
                stdoutHead: typeof stdout === "string" ? stdout.slice(0, 120) : String(stdout),
                count: cleaned ? cleaned.length : 0
            });
            console.log(TAG + " font enum " + attempt.name + " status=" + (result && result.status) +
                " count=" + (cleaned ? cleaned.length : 0) +
                " stdout=" + (typeof stdout === "string" ? stdout.slice(0, 120) : String(stdout)));
            if (cleaned) {
                fonts = cleaned;
                diag.final = attempt.name;
                diag.count = fonts.length;
                persistFontDiagnostics(diag, fonts);
                postFontList();
                return;
            }
        } catch (e) {
            diag.attempts.push({ name: attempt.name, error: String(e).slice(0, 120) });
            console.log(TAG + " font enum " + attempt.name + " failed: " + e);
        }
    }
    // Stale-while-error: a previously persisted full list outranks the
    // built-in fallback when live enumeration is unavailable.
    const cached = loadFontCache();
    if (cached) {
        fonts = cached;
        diag.final = "cache";
        diag.count = fonts.length;
        console.log(TAG + " font enum unavailable; using cached list count=" + fonts.length);
    } else {
        fonts = null;
        diag.final = "fallback";
        console.log(TAG + " font enum unavailable; sidebar keeps its fallback list");
    }
    persistFontDiagnostics(diag, null);
    postFontList();
}
enumerateSystemFonts();

const MEDIA_EXTENSIONS = /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv)$/i;
const MEDIA_TECHNICAL_TOKENS = /\b(?:WEB[-_. ]?DL|WEB[-_. ]?RIP|BLU[-_. ]?RAY|BDRIP|HDTV|HDRIP|REMASTER(?:ED)?|PROPER|LIMITED|UNCUT|AVC|HEVC|H\.?264|H\.?265|X264|X265|10BIT|AAC|FLAC|EAC3|DTS|HDR|SDR|UHD)\b/gi;
const MEDIA_SEASON_EPISODE = /\bS(\d{1,2})\s*E(\d{1,3})\b/i;
const MEDIA_CHINESE_EPISODE = /第\s*0*(\d{1,4})\s*(?:集|话|話|回)/;
const MEDIA_CHINESE_PART = /分\s*P\s*0*(\d+)(?=$|[.\s_-])/i;
const MEDIA_EXPLICIT_PART = /(?:^|[.\s_-])(?:Part|P)\s*0*(\d+)(?=$|[.\s_-])/i;
const MEDIA_TRAILING_EPISODE = /(?:^|-)\s*0*(\d{1,3})\s*$/;
const MEDIA_GENERIC_DIRECTORY = /^(?:tmp|temp|test|tests|downloads?|desktop|documents?|movies|videos?|anime|season(?:\s*\d+)?|series(?:\s*\d+)?|disc\s*\d+|disk\s*\d+|cd\s*\d+)$/i;

function cleanMediaSource(filename) {
    let source = typeof filename === "string" ? filename.trim() : "";
    source = source.replace(MEDIA_EXTENSIONS, "");
    source = source.replace(/\[[^\]]*\]/g, " ");
    source = source.replace(/\b\d{3,4}p\b/gi, " ");
    source = source.replace(/\b\d{3,4}x\d{3,4}\b/gi, " ");
    source = source.replace(MEDIA_TECHNICAL_TOKENS, " ");
    return source.trim();
}

function normalizeMediaTitle(filename) {
    let title = cleanMediaSource(filename);
    title = title.replace(MEDIA_SEASON_EPISODE, " ");
    title = title.replace(MEDIA_CHINESE_EPISODE, " ");
    title = title.replace(MEDIA_CHINESE_PART, " ");
    title = title.replace(MEDIA_EXPLICIT_PART, " ");
    const trailingEpisode = MEDIA_TRAILING_EPISODE.exec(title);
    if (trailingEpisode) {
        title = title.slice(0, trailingEpisode.index);
    }
    title = title.replace(/[|]+/g, " ");
    title = title.replace(/\s*[-_]+\s*/g, " ");
    title = title.replace(/[._]{2,}/g, ".");
    title = title.replace(/\s+/g, " ");
    return title.replace(/^[ ._-]+|[ ._-]+$/g, "").trim();
}

function buildMediaFilenameResult(filename, title, fields) {
    const confident = title.length > 0 && fields.kindHint !== "unknown";
    return {
        filename: filename,
        title: title,
        seasonNumber: fields.seasonNumber,
        episodeNumber: fields.episodeNumber,
        partNumber: fields.partNumber,
        bvid: fields.bvid,
        kindHint: confident ? fields.kindHint : "unknown",
        confidence: confident ? "high" : "low"
    };
}

function parseMediaFilename(filename, parentDirectory) {
    const rawFilename = typeof filename === "string" ? filename.trim() : "";
    const source = cleanMediaSource(rawFilename);
    const filenameTitle = normalizeMediaTitle(source);
    const directoryTitle = normalizeMediaTitle(cleanMediaSource(parentDirectory));
    const bvidMatch = /BV[a-zA-Z0-9]{10}/.exec(source);
    const bvid = bvidMatch ? bvidMatch[0] : null;
    const partMatch = MEDIA_CHINESE_PART.exec(source) || MEDIA_EXPLICIT_PART.exec(source);
    const partNumber = partMatch ? Number(partMatch[1]) : null;
    const seasonEpisodeMatch = MEDIA_SEASON_EPISODE.exec(source);
    const chineseEpisodeMatch = MEDIA_CHINESE_EPISODE.exec(source);
    const trailingEpisodeMatch = MEDIA_TRAILING_EPISODE.exec(source);
    const hasEpisodeNumber = Boolean(
        seasonEpisodeMatch || chineseEpisodeMatch || trailingEpisodeMatch
    );
    const title = hasEpisodeNumber && !bvid && partNumber === null && directoryTitle &&
        !MEDIA_GENERIC_DIRECTORY.test(directoryTitle)
        ? directoryTitle : filenameTitle;

    if (bvid) {
        return buildMediaFilenameResult(rawFilename, title, {
            seasonNumber: null,
            episodeNumber: null,
            partNumber: partNumber,
            bvid: bvid,
            kindHint: "video"
        });
    }

    if (seasonEpisodeMatch) {
        return buildMediaFilenameResult(rawFilename, title, {
            seasonNumber: Number(seasonEpisodeMatch[1]),
            episodeNumber: Number(seasonEpisodeMatch[2]),
            partNumber: null,
            bvid: null,
            kindHint: "bangumi"
        });
    }

    if (chineseEpisodeMatch) {
        return buildMediaFilenameResult(rawFilename, title, {
            seasonNumber: null,
            episodeNumber: Number(chineseEpisodeMatch[1]),
            partNumber: null,
            bvid: null,
            kindHint: "bangumi"
        });
    }

    if (trailingEpisodeMatch && title.length > 0) {
        return buildMediaFilenameResult(rawFilename, title, {
            seasonNumber: null,
            episodeNumber: Number(trailingEpisodeMatch[1]),
            partNumber: null,
            bvid: null,
            kindHint: "bangumi"
        });
    }

    return buildMediaFilenameResult(rawFilename, title, {
        seasonNumber: null,
        episodeNumber: null,
        partNumber: partNumber,
        bvid: null,
        kindHint: partNumber !== null ? "video" : "unknown"
    });
}

function safelyDecodeMediaSource(value) {
    const text = typeof value === "string" ? value : "";
    try {
        return decodeURIComponent(text);
    } catch (e) {
        return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (encodedRun) => {
            try {
                return decodeURIComponent(encodedRun);
            } catch (decodeError) {
                return encodedRun.replace(/%([0-9a-fA-F]{2})/g, (token, hex) => {
                    return parseInt(hex, 16) < 0x80 ? String.fromCharCode(parseInt(hex, 16)) : token;
                });
            }
        });
    }
}

function mediaFilenameFromSource(value) {
    let source = safelyDecodeMediaSource(String(value || "").replace(/[?#].*$/, ""));
    source = source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const segments = source.split(/[\\/]/);
    return segments[segments.length - 1] || source;
}

function mediaDirectoryNameFromSource(value) {
    let source = safelyDecodeMediaSource(String(value || "").replace(/[?#].*$/, ""));
    source = source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const segments = source.split(/[\\/]/).filter(Boolean);
    return segments.length > 1 ? segments[segments.length - 2] : "";
}

function currentFileContext(url) {
    let sourcePath = "";
    try {
        sourcePath = mpv.getString("path") || "";
    } catch (e) { /* path lookup is unavailable in some fixtures/versions */ }
    if (!sourcePath) {
        sourcePath = url || (core.status && core.status.url) || "";
    }

    let filename = "";
    try {
        filename = mpv.getString("filename") || "";
    } catch (e) { /* filename lookup is unavailable in some fixtures/versions */ }
    if (!filename) {
        filename = mediaFilenameFromSource(sourcePath);
    } else {
        filename = mediaFilenameFromSource(filename);
    }
    const parentDirectory = mediaDirectoryNameFromSource(sourcePath);
    return Object.assign(parseMediaFilename(filename, parentDirectory), {
        url: url || (core.status && core.status.url) || null
    });
}

function isCurrentFile(generation) {
    return generation === fileGeneration;
}

function currentLoadState() {
    return { token: loadToken, fileGeneration: fileGeneration };
}

function isCurrentLoad(state) {
    return Boolean(state) && state.token === loadToken &&
        isCurrentFile(state.fileGeneration);
}

function fileLoadedUrl(data) {
    if (typeof data === "string") {
        return data;
    }
    if (data && typeof data === "object") {
        return data.url || data.path || data.filename || null;
    }
    return null;
}

async function recognizeCurrentFile(context, generation, recognitionSearchGeneration) {
    if (!isCurrentFile(generation)) {
        return;
    }
    if (!context || core.status.idle || core.status.isNetworkResource ||
        context.confidence !== "high") {
        return;
    }
    const kind = context.kindHint === "video" || context.kindHint === "bangumi"
        ? context.kindHint : null;
    if (!kind || !context.title) {
        return;
    }

    sidebar.postMessage("status", { text: "正在自动匹配…" });

    const expectedSearchGeneration = recognitionSearchGeneration === undefined
        ? searchGeneration : recognitionSearchGeneration;
    if (searchGeneration !== expectedSearchGeneration) {
        return;
    }
    const isStale = () => !isCurrentFile(generation) ||
        searchGeneration !== expectedSearchGeneration;
    const searchKinds = ["bangumi", "video"];
    const requests = searchKinds.map((searchKind) => requestSearchCandidates(
        searchKind, context.title, expectedSearchGeneration
    ));
    if (requests.some((request) => !request.state)) {
        return;
    }
    let searchResults;
    try {
        searchResults = await Promise.all(requests.map((request) => request.promise));
    } catch (e) {
        if (isStale()) {
            return;
        }
        if (!(kind === "video" && context.bvid)) {
            throw e;
        }
        // An embedded BV id is authoritative even when title search is blocked.
        searchResults = [[], []];
    }
    if (isStale()) {
        return;
    }

    let candidates = searchResults.reduce((all, result) => all.concat(result || []), [])
        .filter((candidate) => candidate.kind === kind);
    if (kind === "video" && context.bvid) {
        candidates = [{
            kind: "video",
            bvid: context.bvid,
            title: context.title,
            direct: true
        }];
    }
    const ranked = rankCandidates(context, candidates);
    const detailed = await Promise.all(ranked.map(async (candidate) => {
        try {
            return await fetchCandidateDetails(candidate, isStale) || candidate;
        } catch (e) {
            console.log(TAG + " candidate detail failed: " + e);
            return candidate;
        }
    }));
    if (isStale()) {
        return;
    }

    const ordered = rankCandidates(context, detailed);
    const decision = chooseAutoTarget(context, ordered);
    const result = {
        context: context,
        generation: generation,
        kind: kind,
        candidates: ordered,
        decision: decision
    };
    currentSuggestionsState = result;
    sidebar.postMessage("suggestions", result);
    if (decision.decision === "load" && automaticLoadEnabled(kind)) {
        await loadAutomaticDecision(context, generation, decision);
    } else if (automaticLoadEnabled(kind)) {
        core.osd(decision.decision === "recommend"
            ? "自动匹配存在歧义，请在侧栏选择"
            : "自动匹配失败，请在侧栏重试");
    }
    return result;
}

function automaticLoadEnabled(kind) {
    return kind === "bangumi" ? settings.autoLoadBangumi : settings.autoLoadVideo;
}

function notifyAutomaticStream(streamId, message) {
    if (!currentStreamMetadata || currentStreamMetadata.origin !== "auto" ||
        currentStreamMetadata.fileGeneration !== fileGeneration ||
        streamId !== currentStreamId || autoHudNotifiedStreamId === streamId) {
        return;
    }
    autoHudNotifiedStreamId = streamId;
    core.osd(message);
}

function automaticStreamMetadata(context, candidate, partIndex, generation) {
    const parts = candidate && candidate.kind === "bangumi"
        ? candidateEpisodes(candidate) : candidatePages(candidate);
    const target = parts[partIndex] || null;
    const number = candidate && candidate.kind === "bangumi"
        ? episodeNumberOf(target) : pageNumberOf(target);
    const fallbackNumber = partIndex + 1;
    const partLabel = candidate && candidate.kind === "bangumi"
        ? "第" + (number === null ? fallbackNumber : number) + "集"
        : "第 " + (number === null ? fallbackNumber : number) + " P";
    return Object.freeze({
        origin: "auto",
        fileGeneration: generation,
        title: stripSearchMarkup(candidate && (candidate.detailTitle || candidate.title) ||
            context.title),
        partLabel: partLabel
    });
}

async function loadAutomaticDecision(context, generation, decision) {
    if (!isCurrentFile(generation) || !automaticLoadEnabled(decision.kind)) {
        return;
    }
    const candidate = decision.candidate;
    const metadata = automaticStreamMetadata(context, candidate, decision.partIndex, generation);
    const loadState = invalidateCurrentLoad();
    sidebar.postMessage("status", { text: "正在自动加载…" });
    if (decision.kind === "bangumi") {
        await loadSeasonById(String(candidate.season_id), loadState, null, metadata,
            decision.partIndex);
    } else {
        await loadBvid(candidate.bvid, loadState, metadata, decision.partIndex);
    }
}

function handleFileLoaded(data) {
    const context = currentFileContext(fileLoadedUrl(data));
    const identity = context.url || context.filename || null;
    if (!identity || identity === currentFileIdentity) {
        return;
    }

    currentFileIdentity = identity;
    fileGeneration += 1;
    invalidateFileLoads();
    if (overlayRequested) {
        overlayLoaded = false;
        if (overlayMessagesRegistered) {
            overlay.postMessage("ping", {});
        }
    }
    const generation = fileGeneration;
    const recognitionSearchGeneration = searchGeneration;
    currentFileContextState = { context: context, generation: generation };
    currentSuggestionsState = null;
    sidebar.postMessage("file-context", currentFileContextState);
    Promise.resolve().then(() => recognizeCurrentFile(
        context, generation, recognitionSearchGeneration
    )).catch((e) => {
        if (isCurrentFile(generation)) {
            reportError(e);
            if (automaticLoadEnabled(context.kindHint)) {
                core.osd("自动匹配失败，请在侧栏重试");
            }
        }
    });
}

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
    const headers = Object.assign({}, BILI_HEADERS);
    // The danmaku endpoint is semi-anonymous: paid/restricted episodes need a
    // logged-in cookie, so attach the user's own SESSDATA only when configured.
    if (sessdata) {
        headers.Cookie = "SESSDATA=" + sessdata;
    }
    const request = () => http.get("https://api.bilibili.com/x/v1/dm/list.so", {
        params: { oid: String(cid) },
        headers: headers,
        data: {}
    });
    let res;
    try { res = await request(); }
    catch (e) {
        if (!headers.Cookie) throw e;
        delete headers.Cookie;
        res = await request();
    }
    if (headers.Cookie && res.statusCode !== 412 && res.statusCode !== 429 &&
        (res.statusCode !== 200 || !/<i(?:\s|>)/.test(res.text || ""))) {
        delete headers.Cookie;
        res = await request();
    }
    if (res.statusCode === 403) {
        throw { network: true, status: res.statusCode, loginRequired: true };
    }
    if (res.statusCode !== 200) {
        throw { network: true, status: res.statusCode };
    }
    return res.text;
}

// ---------------------------------------------------------------------------
// Anonymous danmaku enhancement.
//
// list.so returns a capped, curated XML pool. seg.so exposes the full segmented
// pool as protobuf samples, reachable without a login. Fetching a bounded range
// of segments and merging them into the XML raises the anonymous danmaku count
// without touching login-only history. Every step is best-effort: any failure
// falls back to the original XML.
// ---------------------------------------------------------------------------

const DANMAKU_SEGMENT_SECONDS = 360;
const DANMAKU_SEGMENT_MAX = 40;
const DANMAKU_MODES = [1, 2, 4, 5, 6];
const DANMAKU_SEGMENT_URL = "https://api.bilibili.com/x/v2/dm/web/seg.so";

function readProtobufVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
        if (offset >= bytes.length) {
            return { value: value, offset: offset };
        }
        byte = bytes[offset];
        offset += 1;
        value += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while ((byte & 0x80) !== 0 && shift < 64);
    return { value: value, offset: offset };
}

// JavaScriptCore exposes no TextDecoder, so decode UTF-8 by hand.
function decodeUtf8(bytes, start, end) {
    let out = "";
    let i = start;
    while (i < end) {
        const first = bytes[i];
        i += 1;
        let code;
        if (first < 0x80) {
            code = first;
        } else if ((first & 0xe0) === 0xc0 && i < end) {
            code = ((first & 0x1f) << 6) | (bytes[i] & 0x3f);
            i += 1;
        } else if ((first & 0xf0) === 0xe0 && i + 1 < end) {
            code = ((first & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
            i += 2;
        } else if ((first & 0xf8) === 0xf0 && i + 2 < end) {
            code = ((first & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) |
                ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
            i += 3;
        } else {
            code = 0xfffd;
        }
        if (code > 0xffff) {
            code -= 0x10000;
            out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
        } else {
            out += String.fromCharCode(code);
        }
    }
    return out;
}

function parseDanmakuElement(bytes, start, end) {
    const record = {
        progress: 0, mode: 0, fontsize: 25, color: 16777215,
        midHash: "", content: "", ctime: 0, pool: 0, idStr: ""
    };
    let offset = start;
    while (offset < end) {
        const keyOffset = offset;
        const key = readProtobufVarint(bytes, offset);
        offset = key.offset;
        if (offset <= keyOffset) {
            break; // malformed input made no progress
        }
        const field = Math.floor(key.value / 8);
        const wire = key.value % 8;
        if (wire === 0) {
            const scalar = readProtobufVarint(bytes, offset);
            offset = scalar.offset;
            if (offset <= keyOffset) {
                break;
            }
            if (field === 2) record.progress = scalar.value;
            else if (field === 3) record.mode = scalar.value;
            else if (field === 4) record.fontsize = scalar.value;
            else if (field === 5) record.color = scalar.value;
            else if (field === 8) record.ctime = scalar.value;
            else if (field === 11) record.pool = scalar.value;
        } else if (wire === 2) {
            const len = readProtobufVarint(bytes, offset);
            offset = len.offset;
            const stop = Math.min(offset + len.value, end);
            if (field === 6) record.midHash = decodeUtf8(bytes, offset, stop);
            else if (field === 7) record.content = decodeUtf8(bytes, offset, stop);
            else if (field === 12) record.idStr = decodeUtf8(bytes, offset, stop);
            offset = stop;
        } else if (wire === 5) {
            offset = Math.min(offset + 4, end);
        } else if (wire === 1) {
            offset = Math.min(offset + 8, end);
        } else {
            break;
        }
    }
    return record;
}

function parseDanmakuSegment(bytes) {
    const records = [];
    if (!bytes || bytes.length === 0) {
        return records;
    }
    let offset = 0;
    while (offset < bytes.length) {
        const keyOffset = offset;
        const key = readProtobufVarint(bytes, offset);
        offset = key.offset;
        if (offset <= keyOffset) {
            break; // malformed input made no progress
        }
        const field = Math.floor(key.value / 8);
        const wire = key.value % 8;
        if (field === 1 && wire === 2) {
            const len = readProtobufVarint(bytes, offset);
            offset = len.offset;
            const stop = Math.min(offset + len.value, bytes.length);
            records.push(parseDanmakuElement(bytes, offset, stop));
            offset = stop;
        } else if (wire === 2) {
            const len = readProtobufVarint(bytes, offset);
            offset = Math.min(len.offset + len.value, bytes.length);
        } else if (wire === 0) {
            offset = readProtobufVarint(bytes, offset).offset;
        } else if (wire === 5) {
            offset = Math.min(offset + 4, bytes.length);
        } else if (wire === 1) {
            offset = Math.min(offset + 8, bytes.length);
        } else {
            break;
        }
    }
    return records;
}

function escapeXmlText(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function danmakuRecordToXml(record) {
    const time = (record.progress / 1000).toFixed(3);
    return '<d p="' + time + "," + record.mode + "," + record.fontsize + "," +
        record.color + "," + record.ctime + "," + record.pool + "," +
        escapeXmlText(record.midHash) + "," + escapeXmlText(record.idStr) + '">' +
        escapeXmlText(record.content) + "</d>";
}

function mergeDanmakuRecords(xml, records) {
    const existing = new Set();
    const pattern = /<d p="([^"]*)"/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
        const parts = match[1].split(",");
        if (parts.length > 7) {
            existing.add(parts[7]);
        }
    }
    let appended = "";
    for (const record of records) {
        if (!record.idStr || !record.content) {
            continue;
        }
        if (DANMAKU_MODES.indexOf(record.mode) === -1) {
            continue;
        }
        if (existing.has(record.idStr)) {
            continue;
        }
        existing.add(record.idStr);
        appended += danmakuRecordToXml(record);
    }
    if (!appended) {
        return xml;
    }
    const close = xml.lastIndexOf("</i>");
    if (close === -1) {
        return xml + appended;
    }
    return xml.slice(0, close) + appended + xml.slice(close);
}

async function downloadDanmakuSegment(cid, index, headers) {
    const destination = "@tmp/bili-danmaku-seg-" + index + "-" + Date.now() + ".so";
    let bytes = new Uint8Array(0);
    try {
        await http.download(DANMAKU_SEGMENT_URL, destination, {
            params: { oid: String(cid), segment_index: String(index), type: "1" },
            headers: headers,
            method: "GET"
        });
        const handle = file.handle(destination, "read");
        if (handle) {
            const data = handle.readToEnd();
            if (data) {
                bytes = data;
            }
            handle.close();
        }
    } catch (e) {
        bytes = new Uint8Array(0);
    } finally {
        try {
            file.delete(destination);
        } catch (e) {
            // The temporary segment is best-effort cleanup.
        }
    }
    return bytes;
}

async function enhanceDanmakuWithSegments(cid, xml) {
    try {
        const headers = Object.assign({}, BILI_HEADERS);
        if (sessdata) {
            headers.Cookie = "SESSDATA=" + sessdata;
        }
        const duration = mpv.getNumber("duration");
        const bounded = isFinite(duration) && duration > 0;
        const count = bounded
            ? Math.min(Math.ceil(duration / DANMAKU_SEGMENT_SECONDS), DANMAKU_SEGMENT_MAX)
            : DANMAKU_SEGMENT_MAX;
        const records = [];
        for (let index = 1; index <= count; index += 1) {
            const bytes = await downloadDanmakuSegment(cid, index, headers);
            if (!bytes || bytes.length === 0) {
                // Without a duration we can only probe until the pool runs dry.
                if (!bounded) {
                    break;
                }
                continue;
            }
            const parsed = parseDanmakuSegment(bytes);
            for (const record of parsed) {
                records.push(record);
            }
        }
        if (records.length === 0) {
            return xml;
        }
        return mergeDanmakuRecords(xml, records);
    } catch (e) {
        console.log(TAG + " segment enhance skipped: " + (e && e.message ? e.message : e));
        return xml;
    }
}

// Daily responses are overlapping historical pools, not a guaranteed full archive.
const HISTORY_REQUEST_LIMIT = 400;
const HISTORY_MONTH_LIMIT = 24;
const HISTORY_UNKNOWN_MONTHS = 3;

function historyMonthPlan(published, now) {
    const today = new Date(now + 8 * 3600000);
    const yesterday = new Date(today.getTime() - 86400000);
    const lastDate = yesterday.toISOString().slice(0, 10);
    const current = today.getUTCFullYear() * 12 + today.getUTCMonth();
    let publication = Number(published);
    if (!Number.isFinite(publication) && typeof published === "string") {
        publication = Date.parse(published.replace(" ", "T") + (/Z$|[+-]\d\d:\d\d$/.test(published) ? "" : "+08:00")) / 1000;
    }
    const known = Number.isFinite(publication) && publication >= 1230768000 && publication * 1000 <= now;
    const start = known ? new Date(publication * 1000 + 8 * 3600000) : null;
    const first = known ? start.getUTCFullYear() * 12 + start.getUTCMonth() : current - HISTORY_UNKNOWN_MONTHS + 1;
    const count = Math.min(current - first + 1, HISTORY_MONTH_LIMIT);
    const months = [];
    for (let i = 0; i < count; i += 1) {
        const month = current - i;
        months.push(Math.floor(month / 12) + "-" + String(month % 12 + 1).padStart(2, "0"));
    }
    return { months: months, lastDate: lastDate, limited: !known || current - first + 1 > HISTORY_MONTH_LIMIT };
}

function historyCurrent(job) {
    return historyJob === job && job.authGeneration === authGeneration && Boolean(sessdata) && isCurrentLoad(job.loadState);
}

function historyWait(job) {
    return new Promise((resolve) => {
        job.wake = resolve;
        job.timer = setTimeout(() => { job.wake = null; resolve(); }, 1000);
    });
}

function reportHistory(job, active, text) {
    historyProgress = { active: active, text: text, completed: job.completed, total: job.total, added: job.added };
    sidebar.postMessage("history-progress", historyProgress);
}

function cancelHistoryBackfill(text, keepPartial) {
    const job = historyJob;
    if (!job) return;
    if (keepPartial !== false && historyCurrent(job) && job.added && job.onMerge) job.onMerge(job.xml);
    historyJob = null;
    clearTimeout(job.timer);
    if (job.wake) { job.wake(); job.wake = null; }
    reportHistory(job, false, text || "历史回补已停止");
}

// Validate every protobuf field boundary before using the lenient current-pool parser.
function validProtoMessage(bytes, start, end, nested) {
    let offset = start;
    function varint() {
        const initial = offset;
        while (offset < end && offset - initial < 10) {
            if ((bytes[offset++] & 128) === 0) return true;
        }
        return false;
    }
    while (offset < end) {
        const begin = offset;
        if (!varint()) return false;
        const key = readProtobufVarint(bytes, begin).value;
        const wire = key % 8;
        if (Math.floor(key / 8) === 0) return false;
        if (wire === 0) { if (!varint()) return false; }
        else if (wire === 1) offset += 8;
        else if (wire === 5) offset += 4;
        else if (wire === 2) {
            const from = offset;
            if (!varint()) return false;
            const length = readProtobufVarint(bytes, from).value;
            if (!Number.isSafeInteger(length) || offset + length > end) return false;
            if (nested && Math.floor(key / 8) === 1 && !validProtoMessage(bytes, offset, offset + length, false)) return false;
            offset += length;
        } else return false;
        if (offset > end) return false;
    }
    return offset === end;
}

let nextHistoryFileId = 0;
async function downloadHistoryDay(cid, date, credential) {
    const destination = "@tmp/bili-history-" + Date.now() + "-" + (++nextHistoryFileId) + ".so";
    try {
        await http.download("https://api.bilibili.com/x/v2/dm/web/history/seg.so", destination, {
            params: { type: "1", oid: String(cid), date: date },
            headers: Object.assign({}, BILI_HEADERS, { Cookie: "SESSDATA=" + credential }), method: "GET"
        });
        const handle = file.handle(destination, "read");
        if (!handle) throw { malformedHistory: true };
        let bytes;
        try { bytes = handle.readToEnd(); } finally { handle.close(); }
        if (!bytes || bytes.length > 16 * 1024 * 1024) throw { malformedHistory: true };
        const text = decodeUtf8(bytes, 0, Math.min(bytes.length, 2048)).trim();
        if (text[0] === "{") {
            let body;
            try { body = JSON.parse(text); } catch (e) { throw { malformedHistory: true }; }
            throw { biliCode: body.code, malformedHistory: true };
        }
        if (!validProtoMessage(bytes, 0, bytes.length, true)) throw { malformedHistory: true };
        return parseDanmakuSegment(bytes);
    } finally {
        try { file.delete(destination); } catch (e) { /* best-effort cleanup */ }
    }
}

async function runHistoryBackfill(cid, baseXml, loadState, published, onMerge) {
    if (!sessdata || !isCurrentLoad(loadState)) return baseXml;
    cancelHistoryBackfill("正在加载新的历史来源", false);
    const plan = historyMonthPlan(published, Date.now());
    const job = { loadState: loadState, authGeneration: authGeneration, credential: sessdata,
        xml: baseXml, completed: 0, total: 0, added: 0, requests: 0, timer: null, wake: null, onMerge: onMerge };
    historyJob = job;
    let message = "历史补充完成（" + plan.months.length + " 个月范围" + (plan.limited ? "，范围有限" : "") + "，不保证全量）";
    reportHistory(job, true, "正在查询历史日期；当前弹幕可正常播放");
    try {
        for (const month of plan.months) {
            if (!historyCurrent(job)) return job.xml;
            if (job.requests >= HISTORY_REQUEST_LIMIT) { message = "已达 400 次回补请求上限，保留已获取结果"; break; }
            if (job.requests) await historyWait(job);
            if (!historyCurrent(job)) return job.xml;
            job.requests += 1;
            const index = await biliApi("/x/v2/dm/history/index", { type: "1", oid: String(cid), month: month },
                { Cookie: "SESSDATA=" + job.credential });
            if (!historyCurrent(job)) return job.xml;
            if (index !== null && !Array.isArray(index)) throw { malformedHistory: true };
            const days = Array.from(new Set((index || []).filter((date) => {
                if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month || date > plan.lastDate) return false;
                const parsed = new Date(date + "T00:00:00Z");
                return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
            }))).sort().reverse();
            job.total += days.length;
            for (const date of days) {
                if (job.requests >= HISTORY_REQUEST_LIMIT) { message = "已达 400 次回补请求上限，保留已获取结果"; break; }
                await historyWait(job);
                if (!historyCurrent(job)) return job.xml;
                reportHistory(job, true, "正在回补 " + date + "；可随时取消");
                job.requests += 1;
                const records = await downloadHistoryDay(cid, date, job.credential);
                if (!historyCurrent(job)) return job.xml;
                const before = (job.xml.match(/<d p=/g) || []).length;
                job.xml = mergeDanmakuRecords(job.xml, records);
                job.added += (job.xml.match(/<d p=/g) || []).length - before;
                job.completed += 1;
                reportHistory(job, true, "历史补充进行中；当前弹幕可正常播放");
            }
        }
    } catch (e) {
        if (!historyCurrent(job)) return job.xml;
        const status = e && (e.status || e.statusCode);
        if (e && e.biliCode === -101) {
            sessdata = "";
            accountInfo = null;
            setAuthState("expired", "登录态已失效，已回退匿名模式；请重新登录");
            message = "登录态失效，历史回补中止，保留已获取结果";
        } else if (e && (e.biliCode === -412 || status === 412 || status === 429)) {
            message = "请求受限，历史回补中止，请稍后重试；保留已获取结果";
        } else message = "历史回补部分完成，网络或响应异常导致中止；保留已获取结果";
    }
    if (historyJob === job && isCurrentLoad(loadState) && job.authGeneration === authGeneration) {
        if (job.added && onMerge) onMerge(job.xml);
        historyJob = null;
        reportHistory(job, false, message);
    }
    return job.xml;
}

function reportError(e) {
    let msg = "网络请求失败，请检查网络后重试";
    if (e && (e.biliCode === -404 || e.biliCode === 62002)) {
        msg = "视频不存在或不可见（BV 号无效、视频已删除或仅自己可见）";
    } else if (e && (e.biliCode === -403 || e.loginRequired)) {
        msg = "访问被拒绝（可能为地区/权限限制，或需要大会员登录态）";
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

async function loadPart(index, loadState, streamMetadata) {
    if (!isCurrentLoad(loadState) || !video || index < 0 || index >= video.parts.length) {
        return;
    }
    video.index = index;
    const cid = video.parts[index].cid;
    const label = partLabel(index);
    sidebar.postMessage("status", { text: "正在获取弹幕数据（" + label + "）…" });
    const xml = await biliDanmakuXml(cid);
    if (!isCurrentLoad(loadState)) {
        return; // superseded by a newer load
    }
    const mergedXml = await enhanceDanmakuWithSegments(cid, xml);
    if (!isCurrentLoad(loadState)) {
        return; // superseded by a newer load
    }
    pushToOverlay(mergedXml, streamMetadata);
    pushPartsToSidebar();
    if (!streamMetadata || streamMetadata.origin !== "auto") {
        core.osd("已切换到「" + video.title + "」" + label);
    }
    if (sessdata) {
        void runHistoryBackfill(cid, mergedXml, loadState, video.parts[index].published,
            (updated) => { if (isCurrentLoad(loadState)) pushToOverlay(updated, streamMetadata); });
    }
}

async function loadSource(text) {
    const loadState = invalidateCurrentLoad();
    if (core.status.idle) {
        sidebar.postMessage("error", { message: "请先播放本地视频，再加载弹幕" });
        return;
    }
    const bvid = extractBvid(text);
    if (bvid) {
        await loadBvid(bvid, loadState);
        return;
    }
    const link = extractBangumiLink(text);
    if (link) {
        await loadBangumiLink(link, loadState);
        return;
    }
    sidebar.postMessage("error", { message: "无法识别：请输入 BV 号/视频链接，或番剧 ep/ss/md 链接" });
}

async function loadBvid(bvid, loadState, streamMetadata, preferredPartIndex) {
    sidebar.postMessage("status", { text: "正在获取视频信息…" });
    try {
        const data = await biliApi("/x/web-interface/view", { bvid: bvid });
        if (!isCurrentLoad(loadState)) {
            return;
        }
        video = {
            type: "video",
            bvid: bvid,
            title: data.title,
            parts: data.pages.map((p) => ({ page: p.page, part: p.part, cid: p.cid, published: data.pubdate })),
            index: 0
        };
        console.log(TAG + " video: " + video.title + " (" + video.parts.length + " parts)");
        pushPartsToSidebar();
        const index = Number.isInteger(preferredPartIndex) ? preferredPartIndex : 0;
        await loadPart(index, loadState, streamMetadata);
    } catch (e) {
        if (!isCurrentLoad(loadState)) {
            return;
        }
        reportError(e);
        if (streamMetadata && streamMetadata.origin === "auto") {
            core.osd("自动加载失败，请在侧栏重试");
        }
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

function isCurrentSearch(state) {
    return Boolean(state) && state.generation === searchGeneration &&
        state.fileGeneration === fileGeneration;
}

function stripSearchMarkup(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
}

function normalizeSearchKeyword(keyword) {
    return stripSearchMarkup(keyword).replace(/\s+/g, " ").trim();
}

function normalizeComparableTitle(value) {
    return normalizeSearchKeyword(value).toLowerCase().replace(
        /[\s._\-,:：，。!！?？'"“”‘’·\/\\|()\[\]{}]+/g, ""
    );
}

function titleSimilarity(leftTitle, rightTitle) {
    const left = normalizeComparableTitle(leftTitle);
    const right = normalizeComparableTitle(rightTitle);
    if (!left || !right) {
        return 0;
    }
    if (left === right) {
        return 1;
    }
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    if (longer.indexOf(shorter) >= 0) {
        return 0.75 + 0.2 * shorter.length / longer.length;
    }
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
        prefix += 1;
    }
    return 0.6 * prefix / Math.max(left.length, right.length);
}

function sourceKind(kind) {
    if (kind === "video" || kind === "bangumi") {
        return kind;
    }
    return "unknown";
}

function searchResultYear(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0 || typeof Date !== "function") {
        return null;
    }
    return new Date(value * 1000).getFullYear();
}

function searchCandidateFromResult(kind, result) {
    if (!result || typeof result !== "object") {
        return null;
    }
    if (kind === "bangumi") {
        const seasonId = result.season_id || result.seasonId;
        if (!seasonId) {
            return null;
        }
        const seasonNumber = Number(result.season_number || result.seasonNumber);
        return {
            kind: "bangumi",
            season_id: seasonId,
            title: stripSearchMarkup(result.title || result.org_title || ""),
            year: searchResultYear(result.pubtime),
            seasonNumber: Number.isFinite(seasonNumber) && seasonNumber > 0 ? seasonNumber : null,
            cover: result.cover || result.pic || null
        };
    }
    const bvid = result.bvid || result.bv_id;
    if (!bvid) {
        return null;
    }
    return {
        kind: "video",
        bvid: bvid,
        title: stripSearchMarkup(result.title || ""),
        author: result.author || result.owner && result.owner.name || "",
        cover: result.pic || result.cover || null,
        duration: result.duration || null
    };
}

function searchCacheKey(kind, keyword) {
    return sourceKind(kind) + "\u0000" + normalizeSearchKeyword(keyword).toLowerCase();
}

async function fetchSearchCandidates(kind, keyword, isStale) {
    const normalizedKind = sourceKind(kind);
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    if (normalizedKind === "unknown" || !normalizedKeyword) {
        return [];
    }
    if (isStale && isStale()) {
        return null;
    }

    const key = searchCacheKey(normalizedKind, normalizedKeyword);
    const now = Date.now();
    const cached = searchCache.get(key);
    if (cached) {
        if (cached.expiresAt > now) {
            return cached.candidates.slice();
        }
        searchCache.delete(key);
    }

    const searchType = normalizedKind === "video" ? "video" : "media_bangumi";
    const extraHeaders = {
        "Referer": "https://search.bilibili.com/",
        "Cookie": "buvid3=" + getBuvid()
    };
    const data = await biliApi("/x/web-interface/search/type",
        { search_type: searchType, keyword: normalizedKeyword },
        extraHeaders, isStale);
    if (data === null || (isStale && isStale())) {
        return null;
    }
    const results = Array.isArray(data) ? data : data && Array.isArray(data.result) ? data.result : [];
    const candidates = results.map((result) => searchCandidateFromResult(normalizedKind, result))
        .filter((candidate) => candidate !== null);
    searchCache.set(key, {
        expiresAt: Date.now() + SEARCH_CACHE_TTL,
        candidates: candidates
    });
    return candidates.slice();
}

function parseChineseInteger(value) {
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (!value || !Object.prototype.hasOwnProperty.call(digits, value)) {
        return null;
    }
    return digits[value];
}

function seasonNumberFromText(value) {
    const text = String(value || "");
    let match = /\bS0*(\d{1,2})\b/i.exec(text);
    if (match) {
        return Number(match[1]);
    }
    match = /\bseason\s*0*(\d{1,2})\b/i.exec(text);
    if (match) {
        return Number(match[1]);
    }
    match = /第\s*0*(\d{1,2})\s*季/.exec(text);
    if (match) {
        return Number(match[1]);
    }
    match = /第([一二三四五六七八九十])季/.exec(text);
    return match ? parseChineseInteger(match[1]) : null;
}

function candidateSeasonNumber(candidate) {
    const direct = Number(candidate && (candidate.seasonNumber || candidate.season_number));
    if (Number.isFinite(direct) && direct > 0) {
        return direct;
    }
    return seasonNumberFromText(candidate && (candidate.title || candidate.detailTitle));
}

function candidateEpisodes(candidate) {
    if (candidate && Array.isArray(candidate.episodes)) {
        return candidate.episodes;
    }
    const detail = candidate && (candidate.detail || candidate.details);
    return detail && Array.isArray(detail.episodes) ? detail.episodes : [];
}

function candidatePages(candidate) {
    if (candidate && Array.isArray(candidate.pages)) {
        return candidate.pages;
    }
    const detail = candidate && (candidate.detail || candidate.details);
    return detail && Array.isArray(detail.pages) ? detail.pages : [];
}

function candidateHasEpisode(candidate, episodeNumber) {
    const direct = numberedValue(candidate && (candidate.episodeNumber || candidate.episode_number));
    if (direct === Number(episodeNumber)) {
        return true;
    }
    return candidateEpisodes(candidate).some((episode) =>
        episodeNumberOf(episode) === Number(episodeNumber));
}

function candidateHasPart(candidate, partNumber) {
    const direct = numberedValue(candidate && (candidate.partNumber || candidate.part_number));
    if (direct === Number(partNumber)) {
        return true;
    }
    return candidatePages(candidate).some((page) => pageNumberOf(page) === Number(partNumber));
}

function numberedValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    const text = String(value || "").trim();
    if (/^\d+$/.test(text)) {
        return Number(text);
    }
    const match = /(?:第\s*)?0*(\d+)\s*(?:集|话|話|回|P)?$/i.exec(text);
    return match ? Number(match[1]) : null;
}

function episodeNumberOf(episode) {
    if (!episode) {
        return null;
    }
    for (const value of [episode.episodeNumber, episode.episode_number,
        episode.page, episode.title]) {
        const number = numberedValue(value);
        if (number !== null) {
            return number;
        }
    }
    return null;
}

function pageNumberOf(page) {
    if (!page) {
        return null;
    }
    for (const value of [page.page, page.partNumber, page.part_number, page.title]) {
        const number = numberedValue(value);
        if (number !== null) {
            return number;
        }
    }
    return null;
}

// Some seasons list a short "预告" stub of an episode next to the full episode
// under the same number. Prefer the full entry so the sidebar list and
// automatic matching never resolve to the trailer's near-empty danmaku pool.
function isPreviewEpisode(episode) {
    return Boolean(episode) && typeof episode.badge === "string" &&
        episode.badge.indexOf("预告") >= 0;
}

function preferFullEpisodes(episodes) {
    const list = Array.isArray(episodes) ? episodes.slice() : [];
    const fullNumbers = new Set();
    list.forEach((episode) => {
        if (!isPreviewEpisode(episode)) {
            const number = episodeNumberOf(episode);
            if (number !== null) {
                fullNumbers.add(number);
            }
        }
    });
    return list.filter((episode) => !isPreviewEpisode(episode) ||
        !fullNumbers.has(episodeNumberOf(episode)));
}

function rankCandidates(context, candidates) {
    const source = Array.isArray(candidates) ? candidates : [];
    const title = context && context.title;
    return source.map((candidate, index) => ({
        candidate: candidate,
        index: index,
        titleScore: titleSimilarity(title, candidate && (candidate.title || candidate.detailTitle)),
        hintScore: (context && context.seasonNumber !== null && context.seasonNumber !== undefined &&
            candidateSeasonNumber(candidate) === Number(context.seasonNumber) ? 4 : 0) +
            (context && context.episodeNumber !== null && context.episodeNumber !== undefined &&
            candidateHasEpisode(candidate, context.episodeNumber) ? 2 : 0) +
            (context && context.partNumber !== null && context.partNumber !== undefined &&
            candidateHasPart(candidate, context.partNumber) ? 1 : 0)
    })).sort((left, right) => {
        if (right.titleScore !== left.titleScore) {
            return right.titleScore - left.titleScore;
        }
        if (right.hintScore !== left.hintScore) {
            return right.hintScore - left.hintScore;
        }
        return left.index - right.index;
    }).slice(0, 3).map((entry) => entry.candidate);
}

function normalizeCandidateEpisode(episode) {
    return {
        page: episode && (episode.title || episode.page || ""),
        part: episode && (episode.long_title || episode.part || ""),
        cid: episode && episode.cid,
        ep: episode && (episode.id !== undefined ? episode.id : episode.ep_id)
    };
}

function normalizeCandidatePage(page) {
    return {
        page: page && page.page,
        part: page && (page.part || ""),
        cid: page && page.cid
    };
}

async function fetchCandidateDetails(candidate, isStale) {
    if (!candidate || (isStale && isStale())) {
        return null;
    }
    let result;
    if (candidate.kind === "bangumi") {
        result = await biliApi("/pgc/view/web/season", { season_id: candidate.season_id }, null, isStale);
        if (result === null || (isStale && isStale())) {
            return null;
        }
        const episodes = (Array.isArray(result.episodes) ? result.episodes : []).slice();
        (Array.isArray(result.section) ? result.section : []).forEach((section) => {
            if (section && Array.isArray(section.episodes)) {
                episodes.push(...section.episodes);
            }
        });
        return Object.assign({}, candidate, {
            detailTitle: stripSearchMarkup(result.title || candidate.title),
            episodes: preferFullEpisodes(episodes).map(normalizeCandidateEpisode)
        });
    }
    result = await biliApi("/x/web-interface/view", { bvid: candidate.bvid }, null, isStale);
    if (result === null || (isStale && isStale())) {
        return null;
    }
    return Object.assign({}, candidate, {
        detailTitle: stripSearchMarkup(result.title || candidate.title),
        pages: (Array.isArray(result.pages) ? result.pages : []).map(normalizeCandidatePage)
    });
}

function isHighConfidenceCandidate(context, candidate) {
    if (context && context.bvid && candidate && candidate.bvid === context.bvid) {
        return true;
    }
    return titleSimilarity(context && context.title,
        candidate && (candidate.title || candidate.detailTitle)) >= 0.9;
}

function recommendation(kind, candidates, reason) {
    return { decision: "recommend", kind: kind, candidates: candidates, reason: reason };
}

function resolveCandidateTarget(context, candidate) {
    const kind = context && context.kindHint;
    if (kind === "bangumi") {
        const episodeValue = context.episodeNumber;
        if (episodeValue === null || episodeValue === undefined) {
            return null;
        }
        const episodeNumber = Number(episodeValue);
        if (!Number.isFinite(episodeNumber)) {
            return null;
        }
        const matches = candidateEpisodes(candidate)
            .map((episode, index) => ({ episode: episode, index: index }))
            .filter((entry) => episodeNumberOf(entry.episode) === episodeNumber &&
                entry.episode.cid);
        return matches.length === 1 ? { partIndex: matches[0].index } : null;
    }

    if (kind !== "video") {
        return null;
    }
    const pages = candidatePages(candidate);
    if (!pages.length) {
        return null;
    }
    const partValue = context.partNumber;
    if (partValue === null || partValue === undefined) {
        return pages.length === 1 ? { partIndex: 0 } : null;
    }
    const partNumber = Number(partValue);
    if (!Number.isFinite(partNumber)) {
        return null;
    }
    const matches = pages.map((page, index) => ({ page: page, index: index }))
        .filter((entry) => pageNumberOf(entry.page) === partNumber && entry.page.cid);
    return matches.length === 1 ? { partIndex: matches[0].index } : null;
}

function chooseAutoTarget(context, candidates) {
    const kind = context && (context.kindHint === "video" || context.kindHint === "bangumi")
        ? context.kindHint : "unknown";
    const ranked = Array.isArray(candidates) ? candidates.filter((candidate) =>
        !candidate.kind || candidate.kind === kind) : [];
    if (kind === "unknown") {
        return { decision: "none", kind: kind, reason: "无法确定弹幕源类型" };
    }
    if (!ranked.length) {
        return { decision: "none", kind: kind, reason: "没有找到候选来源" };
    }
    const seasonEligible = kind === "bangumi" && context.seasonNumber !== null &&
        context.seasonNumber !== undefined
        ? ranked.filter((candidate) => {
            const candidateSeason = candidateSeasonNumber(candidate);
            // media_bangumi search results usually omit numeric season metadata;
            // only reject an explicit contradictory season hint.
            return candidateSeason === null || candidateSeason === Number(context.seasonNumber);
        })
        : ranked;
    const strong = seasonEligible.filter((candidate) => isHighConfidenceCandidate(context, candidate));
    const targetable = strong.map((candidate) => ({
        candidate: candidate,
        target: resolveCandidateTarget(context, candidate)
    })).filter((entry) => entry.target !== null);
    if (targetable.length !== 1) {
        return recommendation(kind, ranked, targetable.length > 1
            ? "候选来源存在歧义"
            : (strong.length ? "无法唯一匹配目标分集" : "没有唯一高置信候选"));
    }

    const candidate = targetable[0].candidate;
    return {
        decision: "load",
        kind: kind,
        candidate: candidate,
        partIndex: targetable[0].target.partIndex,
        confidence: "high"
    };
}

function requestSearchCandidates(kind, keyword, generation) {
    const normalizedKind = sourceKind(kind);
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const key = searchCacheKey(normalizedKind, normalizedKeyword);
    const existing = pendingSearches.get(key);
    if (existing && existing.fileGeneration === fileGeneration &&
        existing.generation === searchGeneration &&
        (generation === undefined || existing.generation === generation)) {
        return { promise: existing.promise, state: existing };
    }
    if (generation !== undefined && generation !== searchGeneration) {
        return {
            promise: Promise.resolve(null),
            state: null
        };
    }

    const requestGeneration = generation === undefined ? searchGeneration + 1 : generation;
    if (generation === undefined) {
        searchGeneration = requestGeneration;
        pendingSearches.clear();
    }
    const state = {
        kind: normalizedKind,
        fileGeneration: fileGeneration,
        generation: requestGeneration
    };
    const promise = fetchSearchCandidates(normalizedKind, normalizedKeyword,
        () => !isCurrentSearch(state));
    const pending = Object.assign({}, state, {
        promise: promise,
        manualPromise: null,
        settled: false
    });
    pendingSearches.set(key, pending);
    const clearPendingSearch = () => {
        pending.settled = true;
        if (pendingSearches.get(key) === pending && !pending.manualPromise) {
            pendingSearches.delete(key);
        }
    };
    promise.then(clearPendingSearch, clearPendingSearch);
    return { promise: promise, state: state };
}

async function searchSource(kind, keyword) {
    const normalizedKind = sourceKind(kind);
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    if (!normalizedKeyword) {
        sidebar.postMessage("error", {
            message: normalizedKind === "bangumi" ? "请输入番剧名称" : "请输入视频名称"
        });
        return;
    }
    sidebar.postMessage("status", { text: "正在搜索「" + normalizedKeyword + "」…" });
    let request = null;
    try {
        request = requestSearchCandidates(normalizedKind, normalizedKeyword);
        const candidates = await request.promise;
        if (candidates === null || !isCurrentSearch(request.state)) {
            return;
        }
        if (!candidates.length) {
            sidebar.postMessage("error", { message: "没有搜到相关结果，换个关键词试试" });
            return;
        }
        let displayCandidates = candidates;
        if (normalizedKind === "video") {
            displayCandidates = await Promise.all(candidates.slice(0, 3).map(async (candidate) => {
                try {
                    return await fetchCandidateDetails(candidate,
                        () => !isCurrentSearch(request.state)) || candidate;
                } catch (e) {
                    console.log(TAG + " manual candidate detail failed: " + e);
                    return candidate;
                }
            }));
            if (!isCurrentSearch(request.state)) {
                return;
            }
        }
        const generation = request.state.fileGeneration;
        if (normalizedKind === "bangumi") {
            console.log(TAG + " search: " + candidates.length + " seasons");
            sidebar.postMessage("seasons", {
                generation: generation,
                seasons: candidates.map((candidate) => ({
                    season_id: candidate.season_id,
                    title: candidate.title,
                    year: candidate.year
                }))
            });
            sidebar.postMessage("status", { text: "搜到 " + candidates.length + " 部番剧，请选择" });
        } else {
            sidebar.postMessage("candidates", {
                kind: normalizedKind,
                generation: generation,
                candidates: displayCandidates
            });
            sidebar.postMessage("status", { text: "搜到 " + displayCandidates.length + " 个视频，请选择" });
        }
    } catch (e) {
        if (!request || isCurrentSearch(request.state)) {
            reportError(e);
        }
    }
}

async function searchBangumi(keyword) {
    return searchSource("bangumi", keyword);
}

function requestSourceSearch(kind, keyword) {
    const normalizedKind = sourceKind(kind);
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const key = searchCacheKey(normalizedKind, normalizedKeyword);
    const existing = pendingSearches.get(key);
    if (existing && existing.fileGeneration === fileGeneration &&
        existing.generation === searchGeneration && existing.manualPromise) {
        return existing.manualPromise;
    }

    const promise = searchSource(normalizedKind, normalizedKeyword);
    const pending = pendingSearches.get(key);
    if (pending && pending.fileGeneration === fileGeneration &&
        pending.generation === searchGeneration) {
        pending.manualPromise = promise;
        const clearManualPromise = () => {
            if (pending.manualPromise === promise) {
                pending.manualPromise = null;
                if (pending.settled && pendingSearches.get(key) === pending) {
                    pendingSearches.delete(key);
                }
            }
        };
        promise.then(clearManualPromise, clearManualPromise);
    }
    return promise;
}

function requestBangumiSearch(keyword) {
    return requestSourceSearch("bangumi", keyword);
}

async function loadSeasonById(seasonId, loadState, epId, streamMetadata, preferredPartIndex) {
    sidebar.postMessage("status", { text: "正在获取番剧信息…" });
    try {
        const params = epId ? { ep_id: epId } : { season_id: seasonId };
        const result = await biliApi("/pgc/view/web/season", params);
        if (!isCurrentLoad(loadState)) {
            return;
        }
        const merged = (result.episodes || []).slice();
        (result.section || []).forEach((section) => {
            if (section && Array.isArray(section.episodes)) {
                merged.push(...section.episodes);
            }
        });
        const episodes = preferFullEpisodes(merged);
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
                badge: e.badge,
                published: e.pub_time || result.publish && result.publish.pub_time
            })),
            index: -1
        };
        console.log(TAG + " season: " + video.title + " (" + video.parts.length + " episodes)");
        if (epId) {
            // Direct ep link: jump straight to that episode. When the link
            // points at a "预告" stub that lost its slot to the full episode,
            // fall back to the full episode with the same number.
            let idx = video.parts.findIndex((p) => String(p.ep) === String(epId));
            if (idx < 0) {
                const requested = merged.find((e) =>
                    String(e.id !== undefined ? e.id : e.ep_id) === String(epId));
                const number = requested ? episodeNumberOf(requested) : null;
                if (number !== null) {
                    idx = video.parts.findIndex((p) => episodeNumberOf(p) === number);
                }
            }
            if (idx < 0) {
                sidebar.postMessage("error", { message: "目标分集不在当前剧集列表中" });
                return;
            }
            pushPartsToSidebar();
            await loadPart(idx, loadState, streamMetadata);
        } else if (Number.isInteger(preferredPartIndex) &&
            preferredPartIndex >= 0 && preferredPartIndex < video.parts.length) {
            pushPartsToSidebar();
            await loadPart(preferredPartIndex, loadState, streamMetadata);
        } else if (video.parts.length === 1) {
            pushPartsToSidebar();
            await loadPart(0, loadState, streamMetadata);
        } else {
            pushPartsToSidebar();
            sidebar.postMessage("status", { text: "「" + video.title + "」共 " + video.parts.length + " 集，请选择分集" });
        }
    } catch (e) {
        if (isCurrentLoad(loadState)) {
            reportError(e);
            if (streamMetadata && streamMetadata.origin === "auto") {
                core.osd("自动加载失败，请在侧栏重试");
            }
        }
    }
}

async function loadBangumiLink(link, loadState) {
    try {
        if (link.type === "ep") {
            await loadSeasonById(null, loadState, link.id);
        } else if (link.type === "ss") {
            await loadSeasonById(link.id, loadState, null);
        } else {
            // md -> season_id via review API, then list episodes.
            sidebar.postMessage("status", { text: "正在解析 md 链接…" });
            const result = await biliApi("/pgc/review/user", { media_id: link.id });
            if (!isCurrentLoad(loadState)) {
                return;
            }
            const seasonId = result && result.media && result.media.season_id;
            if (!seasonId) {
                throw { biliCode: -404, biliMessage: "该 md 链接找不到对应剧集" };
            }
            await loadSeasonById(String(seasonId), loadState, null);
        }
    } catch (e) {
        if (isCurrentLoad(loadState)) {
            reportError(e);
        }
    }
}

function cancelOverlayStream() {
    streamPumpGeneration += 1;
    acknowledgeStreamChunk = null;
    pendingStream = null;
    currentStreamId = 0;
    currentStreamMetadata = null;
    autoHudNotifiedStreamId = 0;
    lastPlaybackStateSentAt = 0;
    streamLoading = false;
}

function clearCurrentStream() {
    cancelOverlayStream();
    danmakuActive = false;
    if (overlayLoaded) {
        overlay.postMessage("clear", {});
    }
}

function invalidateFileLoads() {
    cancelHistoryBackfill("文件已切换，历史回补已停止", false);
    searchGeneration += 1;
    pendingSearches.clear();
    video = null;
    clearCurrentStream();
}

function invalidateCurrentLoad() {
    cancelHistoryBackfill("来源已切换，历史回补已停止", false);
    loadToken += 1;
    searchGeneration += 1;
    pendingSearches.clear();
    clearCurrentStream();
    return currentLoadState();
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
        metadata: payload.metadata,
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

function pushToOverlay(xml, streamMetadata) {
    cancelOverlayStream();
    const payload = {
        streamId: ++nextStreamId,
        xml: xml,
        title: video.title,
        settings: overlaySettings()
    };
    if (streamMetadata) {
        payload.metadata = Object.freeze(Object.assign({}, streamMetadata));
    }
    currentStreamId = payload.streamId;
    currentStreamMetadata = payload.metadata || null;
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
                if (currentStreamMetadata && currentStreamMetadata.origin === "auto") {
                    notifyAutomaticStream(data.streamId,
                        "已自动加载「" + currentStreamMetadata.title + "」" +
                        currentStreamMetadata.partLabel);
                }
            } else if (data.phase === "empty") {
                streamLoading = false;
                danmakuActive = false;
                sidebar.postMessage("status", { text: partLabel(video.index) + "暂无弹幕" });
                notifyAutomaticStream(data.streamId, "自动加载未找到弹幕，请在侧栏重试");
            } else if (data.phase === "error") {
                streamLoading = false;
                danmakuActive = false;
                notifyAutomaticStream(data.streamId, "自动加载失败，请在侧栏重试");
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
            notifyAutomaticStream(data.streamId, "自动加载失败，请在侧栏重试");
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

event.on("iina.file-loaded", handleFileLoaded);

event.on("mpv.end-file", () => {
    fileGeneration += 1;
    currentFileIdentity = null;
    currentFileContextState = null;
    currentSuggestionsState = null;
    invalidateFileLoads();
    playbackState.time = null;
    sidebar.postMessage("state", { loaded: false, status: "idle" });
});

console.log(TAG + " main entry loaded");
