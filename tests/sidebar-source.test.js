const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "..", "sidebar", "index.html"), "utf8");

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
        value: "", checked: false, textContent: "", className: "", dataset: {},
        style: {}, children: [], listeners: {}, isFragment: false
    }, init);
    el.classList = makeClassList((el.className || "").split(/\s+/).filter(Boolean));
    let text = el.textContent;
    Object.defineProperty(el, "textContent", {
        get() { return text + el.children.map((child) => child.textContent || "").join(""); },
        set(value) {
            text = value;
            if (value === "") el.children.length = 0;
        }
    });
    el.appendChild = (child) => {
        if (child && child.isFragment) {
            el.children.push(...child.children);
            child.children.length = 0;
            return child;
        }
        el.children.push(child);
        return child;
    };
    el.contains = (target) => target === el || el.children.some((child) =>
        child && child.contains && child.contains(target));
    el.addEventListener = (name, handler) => {
        (el.listeners[name] = el.listeners[name] || []).push(handler);
    };
    el.dispatch = (name, event) => {
        (el.listeners[name] || []).forEach((handler) => handler(event || {}));
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
    return { elements, handlers, messages };
}

function descendants(node) {
    return (node.children || []).flatMap((child) => [child, ...descendants(child)]);
}

function hasClass(node, name) {
    return (node.className || "").split(/\s+/).includes(name);
}

test("source tab has separate automatic and manual sections", () => {
    assert.match(html, /<section id="auto-source"/);
    assert.match(html, /<section id="manual-source"/);
    assert.match(html, /id="auto-file-context"/);
    assert.match(html, /id="auto-recommendations"/);
    assert.match(html, /id="set-auto-bangumi"/);
    assert.match(html, /id="set-auto-video"/);
    assert.match(html, /id="manual-source-input"/);
    assert.match(html, /id="manual-action-btn"/);
    assert.match(html, /id="mode-bangumi"/);
    assert.match(html, /id="mode-video"/);
});

test("settings sync fills independent automatic loading checkboxes", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.settings({ settings: {
        enabled: true, showTop: true, showBottom: true, fontSize: 25,
        fontFamily: "system", strokeWidth: 1, strokeColor: "#000000",
        opacity: 100, speed: 680, offset: 0,
        autoLoadBangumi: true, autoLoadVideo: false
    } });

    assert.equal(fixture.elements["set-auto-bangumi"].checked, true);
    assert.equal(fixture.elements["set-auto-video"].checked, false);

    fixture.elements["set-auto-bangumi"].checked = false;
    fixture.elements["set-auto-bangumi"].onchange();
    fixture.elements["set-auto-video"].checked = true;
    fixture.elements["set-auto-video"].onchange();
    assert.deepEqual(fixture.messages.slice(-2), [
        { name: "update-settings", data: { patch: { autoLoadBangumi: false } } },
        { name: "update-settings", data: { patch: { autoLoadVideo: true } } }
    ]);
});

test("renders file context and a recommendation with a delegated load action", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers["file-context"]({ context: {
        filename: "Show.S02E03.mkv", title: "Show", seasonNumber: 2,
        episodeNumber: 3, kindHint: "bangumi", confidence: "high"
    } });
    fixture.handlers.suggestions({ decision: {
        decision: "load", kind: "bangumi", partIndex: 0,
        candidate: {
            kind: "bangumi", season_id: 12, title: "Show",
            episodes: [{ page: "3", part: "Night", cid: 103 }]
        }
    } });

    assert.match(fixture.elements["auto-file-context"].textContent, /Show\.S02E03\.mkv/);
    assert.match(fixture.elements["auto-recommendations"].textContent, /Show/);
    const load = descendants(fixture.elements["auto-recommendations"])
        .find((node) => hasClass(node, "source-load"));
    assert.ok(load, "recommendation exposes a load button");
    load.onclick();
    assert.equal(fixture.messages.at(-1).name, "load-suggestion");
    assert.equal(fixture.messages.at(-1).data.partIndex, 0);
    assert.equal(fixture.messages.at(-1).data.candidate.season_id, 12);
});

test("manual source mode sends search requests or direct source loads", () => {
    const fixture = loadSidebarFixture();
    const input = fixture.elements["manual-source-input"];
    const action = fixture.elements["manual-action-btn"];

    fixture.elements["mode-bangumi"].onclick();
    input.value = "Show";
    action.onclick();
    assert.deepEqual(fixture.messages.at(-1), {
        name: "search-bangumi", data: { keyword: "Show" }
    });

    fixture.elements["mode-video"].onclick();
    input.value = "Documentary";
    action.onclick();
    assert.deepEqual(fixture.messages.at(-1), {
        name: "search-video", data: { keyword: "Documentary" }
    });

    input.value = "BV1xx411c7mD";
    action.onclick();
    assert.deepEqual(fixture.messages.at(-1), {
        name: "load-source", data: { text: "BV1xx411c7mD" }
    });
});

test("video candidates expose every P as a delegated load action", () => {
    const fixture = loadSidebarFixture();
    fixture.handlers.candidates({ kind: "video", candidates: [{
        kind: "video", bvid: "BV1xx411c7mD", title: "Documentary",
        pages: [{ page: 1, part: "Intro", cid: 101 }, { page: 2, part: "Main", cid: 102 }]
    }] });

    const parts = descendants(fixture.elements["manual-source-list"])
        .filter((node) => hasClass(node, "source-part"));
    assert.equal(parts.length, 2);
    parts[1].onclick();
    assert.deepEqual(fixture.messages.at(-1), {
        name: "load-suggestion",
        data: { candidate: {
            kind: "video", bvid: "BV1xx411c7mD", title: "Documentary",
            pages: [{ page: 1, part: "Intro", cid: 101 }, { page: 2, part: "Main", cid: 102 }]
        }, partIndex: 1 }
    });
});
