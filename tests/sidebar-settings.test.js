const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "..", "sidebar", "index.html"), "utf8");

function loadSidebarFixture() {
    const elements = {};
    for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const attributes = match[2];
        elements[match[3]] = {
            value: (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || "",
            checked: /\bchecked\b/.test(attributes),
            textContent: "",
            classList: { toggle() {} }
        };
    }
    const handlers = {};
    const messages = [];
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
        document: { getElementById(id) { return elements[id] || null; } },
        iina: {
            onMessage(name, handler) { handlers[name] = handler; },
            postMessage(name, data) { messages.push({ name, data: JSON.parse(JSON.stringify(data)) }); }
        }
    });
    return { elements, handlers, messages };
}

const settings = {
    enabled: false, showTop: true, showBottom: false, fontSize: 30,
    fontFamily: "serif", strokeWidth: 2.5, opacity: 80, speed: 900, offset: -2
};

test("declares the five font presets and half-pixel stroke slider after size", () => {
    assert.match(html, /id="set-fontsize"[\s\S]*<select id="set-font-family">[\s\S]*id="set-stroke"[\s\S]*id="set-opacity"/);
    const select = html.match(/<select id="set-font-family">([\s\S]*?)<\/select>/)[1];
    assert.deepEqual(Array.from(select.matchAll(/value="([^"]+)"/g), (match) => match[1]),
        ["system", "sans", "serif", "rounded", "mono"]);
    assert.match(html, /id="set-stroke" min="0" max="3" step="0\.5" value="1"/);
});

test("fills initial settings and labels without sending updates", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings });
    assert.equal(fixture.elements["set-font-family"]?.value, "serif");
    assert.equal(Number(fixture.elements["set-stroke"]?.value), 2.5);
    assert.equal(fixture.elements["val-stroke"]?.textContent, "2.5px");
    assert.equal(fixture.elements["val-offset"].textContent, "-2s");
    assert.equal(fixture.elements["set-enabled"].checked, false);
    assert.deepEqual(fixture.messages, [{ name: "sidebar-ready", data: {} }]);
});

test("each settings control sends only its changed key and updates labels", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings });
    for (const [id, key, value] of [
        ["set-font-family", "fontFamily", "mono"], ["set-stroke", "strokeWidth", 0.5],
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
