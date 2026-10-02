const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const vendorDir = path.join(__dirname, "..", "sidebar", "vendor");
const vendorPath = path.join(vendorDir, "qrcode.min.js");
const scanURL = "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&from=main_web&source=main-fe-header&auth_code=0123456789abcdef0123456789abcdef";

function readVendor() {
    assert.ok(fs.existsSync(vendorPath), "pinned local QRCode library must exist");
    return fs.readFileSync(vendorPath, "utf8");
}

function makeContainer() {
    let html = "";
    return {
        title: "",
        childNodes: [],
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value;
            this.childNodes = [];
            if (!value) return;
            assert.match(value, /^<table\b/);
            const rows = (value.match(/<tr>/g) || []).length;
            const cells = (value.match(/<td\b/g) || []).length;
            const size = value.match(/width:(\d+)px;height:(\d+)px/);
            this.childNodes.push({
                style: {},
                offsetWidth: Number(size[1]) * cells / rows,
                offsetHeight: Number(size[2]) * rows
            });
        }
    };
}

function loadQRCode() {
    // No CanvasRenderingContext2D: exercise the library's actual table fallback.
    const context = vm.createContext({
        document: { documentElement: { tagName: "html" } },
        navigator: { userAgent: "node-fixture" }
    });
    vm.runInContext(readVendor(), context, { filename: vendorPath });
    assert.equal(typeof context.QRCode, "function");
    assert.equal(context.QRCode.CorrectLevel.M, 0);
    return context.QRCode;
}

test("local QRCode distribution records its pinned version and MIT copyright", () => {
    const source = readVendor();
    assert.match(source, /qrcodejs@1\.0\.0/);
    assert.match(source, /https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs@1\.0\.0\/qrcode\.min\.js/);
    assert.match(source, /Copyright \(c\) 2012 davidshimjs/);
    const license = fs.readFileSync(path.join(vendorDir, "LICENSE.qrcodejs"), "utf8");
    assert.match(license, /The MIT License \(MIT\)/);
    assert.match(license, /Copyright \(c\) 2012 davidshimjs/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("vendored QR encoder exactly matches the pinned upstream distribution", () => {
    const source = readVendor().replace(/\/\*![\s\S]*?\*\//, "").trim();
    assert.equal(crypto.createHash("sha256").update(source).digest("hex"),
        "c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36");
});

for (const text of [scanURL, scanURL + "&gourl=" + encodeURIComponent("https://www.bilibili.com/")]) {
    test("QRCode renders a " + text.length + "-character Bilibili scan URL at level M", () => {
        assert.ok(text.length >= 130 && text.length <= 200);
        assert.match(text, /^[\x20-\x7e]+$/);
        const QRCode = loadQRCode();
        const container = makeContainer();
        const qr = new QRCode(container, {
            text, width: 192, height: 192, correctLevel: QRCode.CorrectLevel.M
        });
        const model = qr._oQRCode;
        const count = model.getModuleCount();
        assert.equal(model.errorCorrectLevel, QRCode.CorrectLevel.M);
        assert.equal(count, text === scanURL ? 49 : 57);
        assert.equal(Buffer.from(model.dataList[0].parsedData).toString("ascii"), text);
        assert.equal(container.title, text);
        assert.equal((container.innerHTML.match(/<tr>/g) || []).length, count);
        assert.equal((container.innerHTML.match(/<td\b/g) || []).length, count * count);
        assert.match(container.innerHTML, /background-color:#000000/);
        assert.match(container.innerHTML, /background-color:#ffffff/);
        for (let row = 0; row < count; row++) {
            for (let column = 0; column < count; column++) {
                assert.equal(typeof model.isDark(row, column), "boolean");
            }
        }
        for (let row = 0; row < 7; row++) {
            for (let column = 0; column < 7; column++) {
                const dark = row === 0 || row === 6 || column === 0 || column === 6 ||
                    (row >= 2 && row <= 4 && column >= 2 && column <= 4);
                assert.equal(model.isDark(row, column), dark, "top-left finder pattern");
            }
        }
    });
}

test("QRCode can replace and clear a locally rendered login code", () => {
    const QRCode = loadQRCode();
    const container = makeContainer();
    const qr = new QRCode(container, {
        text: scanURL, width: 192, height: 192, correctLevel: QRCode.CorrectLevel.M
    });
    const previous = container.innerHTML;
    const replacement = scanURL.replace(/0123456789abcdef0123456789abcdef$/, "fedcba9876543210fedcba9876543210");
    qr.makeCode(replacement);
    assert.notEqual(container.innerHTML, previous);
    assert.equal(container.title, replacement);
    assert.equal(Buffer.from(qr._oQRCode.dataList[0].parsedData).toString("ascii"), replacement);
    qr.clear();
    assert.equal(container.innerHTML, "");
    assert.equal(container.childNodes.length, 0);
});
