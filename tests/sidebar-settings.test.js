const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "..", "sidebar", "index.html"), "utf8");

const PRESET_FONTS = ["system", "sans", "serif", "rounded", "mono"];
const FALLBACK_FONTS = [
    "PingFang SC", "Songti SC", "Heiti SC", "Hiragino Sans GB",
    "Kaiti SC", "Yuanti SC", "Lantinghei SC", "Microsoft YaHei",
    "SimHei", "Arial", "Helvetica Neue", "Menlo", "Monaco",
    "Times New Roman", "Georgia", "Courier New"
];

function makeClassList(init) {
    const set = new Set(init || []);
    return {
        toggle(cls, force) {
            if (force === undefined) {
                if (set.has(cls)) set.delete(cls);
                else set.add(cls);
            } else if (force) {
                set.add(cls);
            } else {
                set.delete(cls);
            }
        },
        add(cls) { set.add(cls); },
        remove(cls) { set.delete(cls); },
        contains(cls) { return set.has(cls); }
    };
}

function makeEl(init) {
    const el = Object.assign({
        value: "",
        checked: false,
        disabled: false,
        textContent: "",
        label: "",
        className: "",
        dataset: {},
        style: {},
        children: [],
        listeners: {},
        isFragment: false
    }, init);
    el.classList = makeClassList((el.className || "").split(/\s+/).filter(Boolean));
    let text = el.textContent;
    Object.defineProperty(el, "textContent", {
        get() { return text; },
        set(v) {
            text = v;
            if (v === "") el.children.length = 0;
        }
    });
    Object.defineProperty(el, "firstChild", { get() { return el.children[0] || null; } });
    el.appendChild = (child) => {
        if (child && child.isFragment) {
            el.children.push(...child.children);
            child.children.length = 0;
            return child;
        }
        el.children.push(child);
        return child;
    };
    el.removeChild = (child) => {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        return child;
    };
    el.contains = (target) => {
        if (target === el) return true;
        return el.children.some((c) => c.contains && c.contains(target));
    };
    el.addEventListener = (name, handler) => {
        (el.listeners[name] = el.listeners[name] || []).push(handler);
    };
    el.dispatch = (name, event) => {
        (el.listeners[name] || []).forEach((h) => h(event || {}));
        if (typeof el["on" + name] === "function") el["on" + name](event || {});
    };
    return el;
}

function loadSidebarFixture(options = {}) {
    const elements = {};
    for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const attributes = match[2];
        elements[match[3]] = makeEl({
            value: (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || "",
            checked: /\bchecked\b/.test(attributes),
            disabled: /\bdisabled\b/.test(attributes),
            className: (attributes.match(/\bclass="([^"]*)"/) || [])[1] || ""
        });
    }
    const documentEl = makeEl({});
    const handlers = {};
    const messages = [];
    const qrCalls = [];
    function QRCodeStub(container, config) {
        qrCalls.push({ container, config: JSON.parse(JSON.stringify(config)) });
        container.appendChild(makeEl({ textContent: "QR code", dataset: { url: config.text } }));
        if (options.qrError) throw new Error("QR renderer failed");
    }
    QRCodeStub.CorrectLevel = { M: 0 };
    const globals = {
        document: {
            getElementById(id) { return elements[id] || null; },
            createElement() { return makeEl({}); },
            createDocumentFragment() { return makeEl({ isFragment: true }); },
            addEventListener(name, handler) { documentEl.addEventListener(name, handler); }
        },
        iina: {
            onMessage(name, handler) { handlers[name] = handler; },
            postMessage(name, data) { messages.push({ name, data: JSON.parse(JSON.stringify(data)) }); }
        }
    };
    if (options.qrcode !== false) globals.QRCode = QRCodeStub;
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], globals);
    return { elements, handlers, messages, documentEl, qrCalls };
}

function panelValues(fixture) {
    return fixture.elements["font-family-list"].children.map((c) => c.dataset.value);
}

function visiblePanelValues(fixture) {
    return fixture.elements["font-family-list"].children
        .filter((c) => c.style.display !== "none")
        .map((c) => c.dataset.value);
}

const settings = {
    enabled: false, showTop: true, showBottom: false, fontSize: 30,
    fontFamily: "Songti SC", strokeColor: "#00ff00", strokeWidth: 2.5,
    opacity: 80, speed: 900, offset: -2
};

test("font combo and stroke chip structure match the approved wireframe", () => {
    assert.doesNotMatch(html, /<datalist\b/, "no datalist (unsupported in WKWebView)");
    assert.doesNotMatch(html, /list="font-family-list"/, "input no longer bound to datalist");
    assert.match(html, /id="set-fontsize"[\s\S]*<input type="text" id="set-font-family"[\s\S]*id="font-family-list" class="combo-panel hidden"[\s\S]*id="set-stroke"[\s\S]*id="set-stroke-color"[\s\S]*id="set-opacity"/);
    assert.match(html, /<div id="font-family-list" class="combo-panel hidden">/);
    assert.match(html, /描边 <span id="val-stroke">1px<\/span>\s*\n\s*<span class="stroke-ctl"><input type="range" id="set-stroke"[\s\S]*?class="color-chip"[\s\S]*?<\/span>\s*\n\s*<\/label>/);
    assert.match(html, /class="stroke-ctl"/, "slider and chip grouped on their own line");
    assert.doesNotMatch(html, /class="opt stroke-row"/, "label no longer shares the slider line");
    assert.match(html, /<input type="color" id="set-stroke-color" class="color-chip" value="#000000">/);
    assert.match(html, /id="set-stroke" min="0" max="3" step="0\.5" value="1"/);
    assert.match(html, /\.color-chip\s*\{[^}]*border:\s*2px solid #fff/, "chip has white stroke");
    assert.match(html, /\.color-chip\s*\{[^}]*border-radius:\s*50%/, "chip is circular");
    assert.match(html, /\.color-chip::-webkit-color-swatch\s*\{[^}]*border-radius:\s*50%/, "swatch fill is circular");
    assert.match(html, /\.stroke-ctl\s*\{[^}]*display:\s*flex/, "stroke controls row is a flex line under the label");
    assert.match(html, /\.stroke-ctl input\[type="range"\]\s*\{[^}]*flex:\s*1/, "slider fills the row beside the chip");
});

test("font panel builds once with presets plus fallback fonts", () => {
    const fixture = loadSidebarFixture();
    const values = panelValues(fixture);
    for (const preset of PRESET_FONTS) assert.ok(values.includes(preset), preset + " preset present");
    for (const font of FALLBACK_FONTS) assert.ok(values.includes(font), font + " fallback present");
    assert.equal(values.length, PRESET_FONTS.length + FALLBACK_FONTS.length);
    const panel = fixture.elements["font-family-list"];
    const systemOpt = panel.children.find((c) => c.dataset.value === "system");
    assert.equal(systemOpt.textContent, "系统默认");
    assert.ok(fixture.elements["set-font-family"].classList.contains("hidden") === false);
});

test("fills initial settings and labels without sending updates", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings });
    assert.equal(fixture.elements["set-font-family"]?.value, "Songti SC");
    assert.equal(fixture.elements["set-stroke-color"]?.value, "#00ff00");
    assert.equal(Number(fixture.elements["set-stroke"]?.value), 2.5);
    assert.equal(fixture.elements["val-stroke"]?.textContent, "2.5px");
    assert.equal(fixture.elements["val-offset"].textContent, "-2s");
    assert.equal(fixture.elements["set-enabled"].checked, false);
    assert.deepEqual(fixture.messages, [{ name: "sidebar-ready", data: {} }]);
});

test("settings handler guards invalid strokeColor", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings: { ...settings, strokeColor: "red" } });
    assert.equal(fixture.elements["set-stroke-color"].value, "#000000");
});

test("account controls are labeled, live, and use only the local QR renderer", () => {
    assert.match(html, /<section id="account-section"[^>]*aria-labelledby="account-title"/);
    assert.match(html, /id="auth-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="auth-qr-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="history-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /<label[^>]*for="auth-cookie-input"/);
    assert.match(html, /<input type="password" id="auth-cookie-input"[^>]*autocomplete="off"/);
    assert.match(html, /id="auth-qr-code"[^>]*role="img"[^>]*aria-label="B 站登录二维码"/);
    assert.match(html, /<script src="vendor\/qrcode\.min\.js"><\/script>/);
    assert.match(html, /macOS 钥匙串/);
    assert.match(html, /旧版 SESSDATA 仅在钥匙串迁移成功后清除/);
    assert.match(html, /迁移失败会保留旧设置/);
    assert.doesNotMatch(html, /id="set-sessdata"|ctl\.sessdata|s\.sessdata|\bsessdata\s*:/);
    assert.doesNotMatch(html, /(?:https?:)?\/\/[^\s"']*(?:qrserver|quickchart|googleapis)/i);
    const fixture = loadSidebarFixture();
    for (const id of ["auth-qr-start", "auth-logout", "auth-qr-refresh", "auth-qr-cancel",
        "auth-cookie-save", "history-cancel"]) {
        assert.equal(typeof fixture.elements[id]?.onclick, "function", id + " is wired");
    }
    assert.ok(fixture.elements["auth-qr-area"].classList.contains("hidden"));
});

test("settings and auth messages never refill or broadcast stored credentials", () => {
    const fixture = loadSidebarFixture();
    const input = fixture.elements["auth-cookie-input"];
    assert.ok(input, "dedicated cookie input exists");
    fixture.handlers.settings({ settings: { ...settings, sessdata: "stored-secret", cookie: "stored-cookie" } });
    fixture.handlers["auth-state"]({ status: "authenticated", loggedIn: true, message: "登录成功",
        sessdata: "stored-secret", cookie: "stored-cookie" });
    assert.equal(input.value, "");
    assert.deepEqual(fixture.messages, [{ name: "sidebar-ready", data: {} }]);
    input.value = "manually-pasted-secret";
    input.dispatch("input");
    input.dispatch("change");
    fixture.handlers.settings({ settings: { ...settings, sessdata: "other-stored-secret" } });
    assert.equal(input.value, "manually-pasted-secret", "settings do not touch the auth input");
    fixture.elements["set-font-family"].value = "Menlo";
    fixture.elements["set-font-family"].onchange();
    assert.deepEqual(fixture.messages, [
        { name: "sidebar-ready", data: {} },
        { name: "update-settings", data: { patch: { fontFamily: "Menlo" } } }
    ]);
});

test("saving a cookie posts its raw value only through auth and immediately clears the input", () => {
    const fixture = loadSidebarFixture();
    const input = fixture.elements["auth-cookie-input"];
    assert.ok(input, "dedicated cookie input exists");
    const cookie = "  SESSDATA=next%2C1%2Ctoken; bili_jct=test  ";
    input.value = cookie;
    const before = fixture.messages.length;
    fixture.elements["auth-cookie-save"].onclick();
    assert.equal(fixture.messages.length, before + 1);
    assert.deepEqual(fixture.messages.at(-1), {
        name: "auth-cookie", data: { cookie }
    });
    assert.equal(input.value, "");
    assert.match(fixture.elements["auth-status"].textContent, /验证/);
});

test("cookie save rejects blank input and supports Enter without settings updates", () => {
    const fixture = loadSidebarFixture();
    const input = fixture.elements["auth-cookie-input"];
    assert.ok(input, "dedicated cookie input exists");
    input.value = "   ";
    fixture.elements["auth-cookie-save"].onclick();
    assert.deepEqual(fixture.messages, [{ name: "sidebar-ready", data: {} }]);
    assert.ok(fixture.elements["auth-status"].classList.contains("error"));
    input.value = "raw-sessdata";
    input.dispatch("keydown", { key: "Enter", preventDefault() {} });
    assert.deepEqual(fixture.messages.at(-1), { name: "auth-cookie", data: { cookie: "raw-sessdata" } });
    assert.equal(input.value, "");
});

test("auth state updates login controls and logout never includes credentials", () => {
    const fixture = loadSidebarFixture();
    const start = fixture.elements["auth-qr-start"];
    const save = fixture.elements["auth-cookie-save"];
    const logout = fixture.elements["auth-logout"];
    assert.ok(start && save && logout, "login controls exist");
    assert.equal(start.disabled, false);
    assert.equal(logout.disabled, true);
    fixture.handlers["auth-state"]({ status: "checking", loggedIn: false, message: "正在检查账号" });
    assert.equal(start.disabled, true);
    assert.equal(save.disabled, true);
    assert.equal(fixture.elements["auth-status"].textContent, "正在检查账号");
    fixture.handlers["auth-state"]({ status: "authenticated", loggedIn: true, message: "已登录" });
    assert.equal(logout.disabled, false);
    assert.equal(save.disabled, false);
    fixture.elements["auth-cookie-input"].value = "unsaved-secret";
    logout.onclick();
    assert.deepEqual(fixture.messages.at(-1), { name: "auth-logout", data: {} });
    assert.equal(fixture.elements["auth-cookie-input"].value, "");
    for (const status of ["anonymous", "error", "expired"]) {
        fixture.handlers["auth-state"]({ status, loggedIn: false, message: "账号状态：" + status });
        assert.equal(start.disabled, false);
        assert.equal(fixture.elements["auth-status"].classList.contains("error"), status !== "anonymous");
        assert.equal(fixture.elements["auth-status"].textContent, "账号状态：" + status);
    }
    assert.equal(fixture.messages.filter((message) => message.name === "update-settings").length, 0);
});

test("anonymous warning explains missing historical backfill, not missing current or VIP danmaku", () => {
    const fixture = loadSidebarFixture();
    const impact = fixture.elements["anonymous-impact"];
    assert.ok(impact, "anonymous consequence copy exists");
    const copy = html.match(/<div id="anonymous-impact"[^>]*>([^<]*)<\/div>/)[1];
    assert.match(copy, /当前弹幕池可正常加载/);
    assert.match(copy, /无法回补历史弹幕/);
    assert.match(copy, /少于 B 站页面统计/);
    assert.doesNotMatch(copy, /大会员.*(需要|才能).*弹幕/);
    assert.match(html, /id="auth-status"[^>]*>未登录 · 匿名模式</);
});

test("auth state shows account name and big-member tier or nonmember status", () => {
    const fixture = loadSidebarFixture();
    const impact = fixture.elements["anonymous-impact"];
    const account = fixture.elements["authenticated-account"];
    const name = fixture.elements["account-name"];
    const membership = fixture.elements["membership-status"];
    fixture.handlers["auth-state"]({ status: "anonymous", loggedIn: false, message: "匿名模式" });
    assert.ok(!impact.classList.contains("hidden"));
    assert.ok(account.classList.contains("hidden"));

    fixture.handlers["auth-state"]({ status: "authenticated", loggedIn: true,
        message: "已登录", account: { uname: "测试账号", vipStatus: 1, vipType: 2,
            vipDueDate: 1798761600000, vipLabel: "年度大会员" } });
    assert.ok(impact.classList.contains("hidden"));
    assert.ok(!account.classList.contains("hidden"));
    assert.equal(name.textContent, "当前账号：测试账号");
    assert.match(membership.textContent, /年度大会员/);
    assert.match(membership.textContent, /有效至/);

    fixture.handlers["auth-state"]({ status: "authenticated", loggedIn: true,
        message: "已登录", account: { uname: "普通用户", vipStatus: 0, vipType: 0 } });
    assert.equal(name.textContent, "当前账号：普通用户");
    assert.match(membership.textContent, /未开通大会员/);
});

const qrURL = "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=test-key";
test("expired or undeletable persisted credentials still expose logout", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers["auth-state"]({ status: "expired", loggedIn: false, canLogout: true, message: "登录态失效" });
    assert.equal(fixture.elements["auth-logout"].disabled, false);
    fixture.handlers["auth-state"]({ status: "error", loggedIn: false, canLogout: true, message: "钥匙串删除失败" });
    assert.equal(fixture.elements["auth-logout"].disabled, false);
});

test("QR start, refresh, scan and cancel keep the code local and transient", () => {
    const fixture = loadSidebarFixture();
    assert.ok(fixture.elements["auth-qr-start"], "QR start control exists");
    fixture.elements["auth-qr-start"].onclick();
    assert.deepEqual(fixture.messages.at(-1), { name: "auth-qr-start", data: {} });
    assert.ok(!fixture.elements["auth-qr-area"].classList.contains("hidden"));
    fixture.handlers["auth-qr"]({ status: "loading", message: "正在获取二维码" });
    fixture.handlers["auth-qr"]({ status: "waiting", url: qrURL, message: "请使用哔哩哔哩扫码" });
    assert.equal(fixture.qrCalls.length, 1);
    assert.equal(fixture.qrCalls[0].container, fixture.elements["auth-qr-code"]);
    assert.deepEqual(fixture.qrCalls[0].config, { text: qrURL, width: 192, height: 192, correctLevel: 0 });
    assert.equal(fixture.elements["auth-qr-code"].children.length, 1);
    fixture.handlers["auth-qr"]({ status: "scanned", message: "已扫码，请确认" });
    assert.equal(fixture.qrCalls.length, 1, "polling status does not recreate the QR code");
    assert.equal(fixture.elements["auth-qr-status"].textContent, "已扫码，请确认");
    fixture.elements["auth-qr-refresh"].onclick();
    assert.deepEqual(fixture.messages.at(-1), { name: "auth-qr-start", data: {} });
    assert.equal(fixture.elements["auth-qr-code"].children.length, 0, "refresh discards the old QR URL");
    fixture.handlers["auth-qr"]({ status: "waiting", url: qrURL + "-new", message: "等待扫码" });
    assert.equal(fixture.qrCalls.length, 2);
    fixture.elements["auth-qr-cancel"].onclick();
    assert.deepEqual(fixture.messages.at(-1), { name: "auth-qr-cancel", data: {} });
    assert.equal(fixture.elements["auth-qr-code"].children.length, 0);
    assert.ok(fixture.elements["auth-qr-area"].classList.contains("hidden"));
    fixture.handlers["auth-qr"]({ status: "waiting", url: qrURL, message: "迟到的二维码" });
    assert.equal(fixture.elements["auth-qr-code"].children.length, 0, "cancelled QR cannot reappear");
});

for (const status of ["expired", "error", "success", "cancelled"]) {
    test("QR " + status + " clears its URL and rendered content", () => {
        const fixture = loadSidebarFixture();
        assert.ok(fixture.elements["auth-qr-start"], "QR start control exists");
        fixture.elements["auth-qr-start"].onclick();
        fixture.handlers["auth-qr"]({ status: "waiting", url: qrURL, message: "等待扫码" });
        fixture.handlers["auth-qr"]({ status, url: qrURL, message: "二维码状态：" + status });
        assert.equal(fixture.elements["auth-qr-code"].children.length, 0);
        assert.ok(fixture.elements["auth-qr-code"].classList.contains("hidden"));
        assert.equal(fixture.elements["auth-qr-status"].textContent, "二维码状态：" + status);
        assert.equal(fixture.elements["auth-qr-area"].classList.contains("hidden"),
            status === "success" || status === "cancelled");
        assert.equal(fixture.elements["auth-qr-status"].classList.contains("error"),
            status === "expired" || status === "error");
        fixture.handlers["auth-qr"]({ status: "scanned", url: qrURL, message: "迟到的扫码状态" });
        assert.equal(fixture.elements["auth-qr-code"].children.length, 0);
    });
}

for (const options of [{ qrcode: false }, { qrError: true }]) {
    test("QR rendering failure is visible and leaves cookie login and refresh available " + JSON.stringify(options), () => {
        const fixture = loadSidebarFixture(options);
        assert.ok(fixture.elements["auth-qr-start"], "QR start control exists");
        fixture.elements["auth-qr-start"].onclick();
        assert.doesNotThrow(() => fixture.handlers["auth-qr"]({ status: "waiting", url: qrURL, message: "等待扫码" }));
        assert.equal(fixture.elements["auth-qr-code"].children.length, 0);
        assert.ok(fixture.elements["auth-qr-status"].classList.contains("error"));
        assert.match(fixture.elements["auth-qr-status"].textContent, /二维码.*失败.*Cookie/);
        assert.equal(fixture.elements["auth-qr-refresh"].disabled, false);
        assert.equal(fixture.elements["auth-cookie-save"].disabled, false);
    });
}

test("history progress exposes counters and cancellation without modifying settings", () => {
    const fixture = loadSidebarFixture();
    assert.ok(fixture.elements["history-cancel"], "history cancel control exists");
    const cancel = fixture.elements["history-cancel"];
    assert.equal(cancel.disabled, true);
    fixture.handlers["history-progress"]({ active: true, text: "正在回补历史弹幕", completed: 2, total: 5, added: 123 });
    assert.match(fixture.elements["history-status"].textContent, /正在回补历史弹幕.*2\/5.*123/);
    assert.equal(cancel.disabled, false);
    assert.ok(!fixture.elements["history-actions"].classList.contains("hidden"));
    cancel.onclick();
    assert.deepEqual(fixture.messages.at(-1), { name: "history-cancel", data: {} });
    assert.equal(cancel.disabled, true);
    assert.match(fixture.elements["history-status"].textContent, /取消/);
    fixture.handlers["history-progress"]({ active: false, text: "回补已取消", completed: 2, total: 5, added: 123 });
    assert.equal(cancel.disabled, true);
    assert.ok(fixture.elements["history-actions"].classList.contains("hidden"));
    assert.match(fixture.elements["history-status"].textContent, /回补已取消/);
    assert.equal(fixture.messages.filter((message) => message.name === "update-settings").length, 0);
});

test("each settings control sends only its changed key and updates labels", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings });
    for (const [id, key, value] of [
        ["set-font-family", "fontFamily", "PingFang SC"], ["set-stroke", "strokeWidth", 0.5],
        ["set-stroke-color", "strokeColor", "#ff8800"],
        ["set-fontsize", "fontSize", 32], ["set-opacity", "opacity", 70],
        ["set-speed", "speed", 800], ["set-offset", "offset", 3],
        ["set-enabled", "enabled", true], ["set-top", "showTop", false],
        ["set-bottom", "showBottom", true]
    ]) {
        const control = fixture.elements[id];
        assert.ok(control, id + " exists");
        if (typeof value === "boolean") control.checked = value;
        else control.value = String(value);
        const before = fixture.messages.length;
        control.onchange();
        assert.equal(fixture.messages.length, before + 1);
        assert.deepEqual(fixture.messages.at(-1), { name: "update-settings", data: { patch: { [key]: value } } });
    }
    assert.equal(fixture.elements["val-stroke"].textContent, "0.5px");
    fixture.handlers.settings({ settings: { ...settings, strokeWidth: 0 } });
    assert.equal(fixture.elements["val-stroke"].textContent, "0px");
});

test("picking a font from the panel fills the input and posts one patch", () => {
    const fixture = loadSidebarFixture();
    const panel = fixture.elements["font-family-list"];
    const target = panel.children.find((c) => c.dataset.value === "Songti SC");
    assert.ok(target, "Songti SC option exists in panel");
    const before = fixture.messages.length;
    target.onmousedown();
    assert.equal(fixture.elements["set-font-family"].value, "Songti SC");
    assert.equal(fixture.messages.length, before + 1);
    assert.deepEqual(fixture.messages.at(-1), {
        name: "update-settings", data: { patch: { fontFamily: "Songti SC" } }
    });
    assert.ok(panel.classList.contains("hidden"), "panel closes after pick");
});

test("typing filters panel options via display toggle without posting messages", () => {
    const fixture = loadSidebarFixture();
    const input = fixture.elements["set-font-family"];
    const panel = fixture.elements["font-family-list"];
    assert.ok(panel.classList.contains("hidden"), "panel starts closed");
    const before = fixture.messages.length;
    input.value = "song";
    input.dispatch("input", {});
    assert.equal(fixture.messages.length, before, "input events never post messages");
    assert.ok(!panel.classList.contains("hidden"), "typing opens the panel");
    const visible = visiblePanelValues(fixture);
    assert.ok(visible.includes("Songti SC"));
    assert.ok(!visible.includes("Menlo"), "non-matching options hidden, not destroyed");
    assert.equal(panel.children.length, PRESET_FONTS.length + FALLBACK_FONTS.length, "nodes are not rebuilt by filtering");
    input.value = "";
    input.dispatch("input", {});
    assert.equal(visiblePanelValues(fixture).length, panel.children.length);
});

test("opening the panel shows the full list even when the input holds a committed value", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings });
    const input = fixture.elements["set-font-family"];
    const panel = fixture.elements["font-family-list"];
    assert.equal(input.value, "Songti SC", "input holds the persisted preset id");
    const messagesBefore = fixture.messages.length;
    input.dispatch("focus", {});
    assert.ok(!panel.classList.contains("hidden"), "focus opens the panel");
    assert.equal(fixture.messages.length, messagesBefore, "opening posts nothing");
    assert.equal(visiblePanelValues(fixture).length, panel.children.length,
        "committed value must not filter the opened list");
    const input2 = loadSidebarFixture();
    input2.handlers.settings({ settings: { ...settings, fontFamily: "system" } });
    input2.elements["set-font-family"].dispatch("focus", {});
    const visible = visiblePanelValues(input2);
    assert.ok(visible.includes("system"));
    assert.ok(visible.includes("serif"), "other presets stay visible");
    assert.ok(visible.includes("PingFang SC"), "fallback fonts stay visible");
});

test("font-list handler rebuilds panel with presets and enumerated fonts", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers["font-list"]({ fonts: ["PingFang SC", "Songti SC", "NewFont"] });
    const values = panelValues(fixture);
    assert.deepEqual(values, [...PRESET_FONTS, "PingFang SC", "Songti SC", "NewFont"]);
    assert.ok(values.includes("system"), "presets never dropped");
});

test("font-list handler with null or empty fonts keeps the fallback panel", () => {
    const fixture = loadSidebarFixture();
    const before = panelValues(fixture);
    fixture.handlers["font-list"]({ fonts: null });
    assert.deepEqual(panelValues(fixture), before);
    fixture.handlers["font-list"]({ fonts: [] });
    assert.deepEqual(panelValues(fixture), before);
    assert.ok(before.includes("system"));
    assert.ok(before.includes("PingFang SC"));
});

test("font-list handler caps total panel options at 1000", () => {
    const fixture = loadSidebarFixture();
    const many = Array.from({ length: 1400 }, (_, i) => "Font" + i);
    fixture.handlers["font-list"]({ fonts: many });
    const values = panelValues(fixture);
    assert.equal(values.length, 1000);
    assert.deepEqual(values.slice(0, 5), PRESET_FONTS);
    assert.equal(values[5], "Font0");
});
