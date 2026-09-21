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

function loadSidebarFixture() {
    const elements = {};
    for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const attributes = match[2];
        elements[match[3]] = makeEl({
            value: (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || "",
            checked: /\bchecked\b/.test(attributes),
            className: (attributes.match(/\bclass="([^"]*)"/) || [])[1] || ""
        });
    }
    const documentEl = makeEl({});
    const handlers = {};
    const messages = [];
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
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
    });
    return { elements, handlers, messages, documentEl };
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
