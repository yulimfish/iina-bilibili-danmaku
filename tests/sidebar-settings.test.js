const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "..", "sidebar", "index.html"), "utf8");

const PRESET_FONTS = ["system", "sans", "serif", "rounded", "mono"];

function makeEl(init) {
    const el = Object.assign({
        value: "",
        checked: false,
        textContent: "",
        label: "",
        children: [],
        classList: { toggle() {} }
    }, init);
    Object.defineProperty(el, "firstChild", { get() { return el.children[0] || null; } });
    el.appendChild = (child) => { el.children.push(child); return child; };
    el.removeChild = (child) => {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        return child;
    };
    return el;
}

function parseDatalistFallback() {
    const block = html.match(/<datalist id="font-family-list">([\s\S]*?)<\/datalist>/);
    assert.ok(block, "datalist font-family-list exists");
    return Array.from(block[1].matchAll(/<option\b([^>]*)>/g), (m) => ({
        value: (m[1].match(/\bvalue="([^"]*)"/) || [])[1] || "",
        label: (m[1].match(/\blabel="([^"]*)"/) || [])[1] || ""
    }));
}

function optionValues(el) {
    return el.children.map((c) => c.value);
}

function loadSidebarFixture() {
    const fallback = parseDatalistFallback();
    const elements = {};
    for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const attributes = match[2];
        elements[match[3]] = makeEl({
            value: (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || "",
            checked: /\bchecked\b/.test(attributes)
        });
    }
    if (elements["font-family-list"]) {
        fallback.forEach((o) => elements["font-family-list"].appendChild(makeEl({ value: o.value, label: o.label })));
    }
    const handlers = {};
    const messages = [];
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
        document: {
            getElementById(id) { return elements[id] || null; },
            createElement() { return makeEl(); }
        },
        iina: {
            onMessage(name, handler) { handlers[name] = handler; },
            postMessage(name, data) { messages.push({ name, data: JSON.parse(JSON.stringify(data)) }); }
        }
    });
    return { elements, handlers, messages, fallback };
}

const settings = {
    enabled: false, showTop: true, showBottom: false, fontSize: 30,
    fontFamily: "Songti SC", strokeColor: "#00ff00", strokeWidth: 2.5,
    opacity: 80, speed: 900, offset: -2
};

test("font family is a datalist text input and stroke row has a color input in order", () => {
    assert.match(html, /id="set-fontsize"[\s\S]*<input type="text" id="set-font-family" list="font-family-list"[\s\S]*id="set-stroke"[\s\S]*id="set-stroke-color"[\s\S]*id="set-opacity"/);
    assert.doesNotMatch(html, /<select id="set-font-family">/);
    assert.match(html, /<input type="color" id="set-stroke-color" value="#000000"/);
    assert.match(html, /id="set-stroke" min="0" max="3" step="0\.5" value="1"/);
    const options = parseDatalistFallback();
    const values = options.map((o) => o.value);
    for (const preset of PRESET_FONTS) assert.ok(values.includes(preset), preset + " preset present");
    assert.ok(values.includes("PingFang SC"));
    assert.equal(options.find((o) => o.value === "system").label, "系统默认");
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

test("font-list handler repopulates datalist keeping presets", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers["font-list"]({ fonts: ["PingFang SC", "Songti SC"] });
    const values = optionValues(fixture.elements["font-family-list"]);
    assert.deepEqual(values, ["system", "sans", "serif", "rounded", "mono", "PingFang SC", "Songti SC"]);
    assert.ok(values.includes("system"));
});

test("font-list handler with null fonts keeps fallback options", () => {
    const fixture = loadSidebarFixture();
    const before = optionValues(fixture.elements["font-family-list"]);
    fixture.handlers["font-list"]({ fonts: null });
    assert.deepEqual(optionValues(fixture.elements["font-family-list"]), before);
    assert.deepEqual(before, fixture.fallback.map((o) => o.value));
    assert.ok(before.includes("system"));
    assert.ok(before.includes("PingFang SC"));
});
