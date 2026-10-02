const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

// Reuse the real entry fixture without registering its unrelated tests.
const harness = fs.readFileSync(path.join(__dirname, "main-stream.test.js"), "utf8")
    .split('test("parses local filenames')[0];
const harnessContext = { require, __dirname, console, setTimeout, clearTimeout, Buffer };
vm.runInNewContext(harness + "\nthis.loadMainFixture = loadMainFixture; this.segmentBytes = danmakuSegmentBytes;", harnessContext);
const { loadMainFixture } = harnessContext;
const token = "abc123%2C1700000000%2Cxyz789";
const otherToken = "other1%2C1700000000%2Ctoken2";
const json = (data, code = 0) => ({ statusCode: 200, text: JSON.stringify({ code, data }) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const states = (f) => f.sidebarMessages.filter((m) => m.name === "auth-state");

test("Cookie login validates and stores only SESSDATA in Keychain", async () => {
    const requests = [];
    const profile = { isLogin: true, uname: "测试账号", vipStatus: 1, vipType: 2,
        vipDueDate: 1798761600000, vip: { label: { text: "年度大会员" } } };
    const f = loadMainFixture({ httpGet(url, options) {
        if (!url.includes("/nav")) return undefined;
        requests.push(options);
        return json(profile);
    } });
    await f.sidebarHandlers["auth-cookie"]({ cookie: "buvid3=unneeded; SESSDATA=" + token + "; bili_jct=not-kept" });
    assert.equal(requests[0].headers.Cookie, "SESSDATA=" + token);
    assert.equal(f.keychainValue, token);
    assert.equal(states(f).at(-1).data.loggedIn, true);
    assert.deepEqual(JSON.parse(JSON.stringify(states(f).at(-1).data.account)), {
        uname: "测试账号", vipStatus: 1, vipType: 2, vipDueDate: 1798761600000, vipLabel: "年度大会员"
    });
    assert.ok(!JSON.stringify(f.prefs).includes(token));
    assert.ok(!JSON.stringify(f.sidebarMessages.concat(f.overlayMessages)).includes(token));
});

test("account state identifies a logged-in user without active big-member benefits", async () => {
    const f = loadMainFixture({ httpGet: (url) => url.includes("/nav")
        ? json({ isLogin: true, uname: "普通用户", vipStatus: 0, vipType: 0, vipDueDate: 0 }) : undefined });
    await f.sidebarHandlers["auth-cookie"]({ cookie: token });
    assert.deepEqual(JSON.parse(JSON.stringify(states(f).at(-1).data.account)), {
        uname: "普通用户", vipStatus: 0, vipType: 0, vipDueDate: null, vipLabel: ""
    });
    assert.equal(states(f).at(-1).data.loggedIn, true);
});

test("invalid Cookie and expired login do not replace existing credentials", async () => {
    const f = loadMainFixture({ keychain: token, httpGet: (url) => url.includes("/nav")
        ? json(null, -101) : undefined });
    await tick();
    for (const cookie of ["buvid3=only", "SESSDATA=x\r\nX-Test: bad", "SESSDATA=" + "x".repeat(301), ""] ) {
        await f.sidebarHandlers["auth-cookie"]({ cookie });
    }
    await f.sidebarHandlers["auth-cookie"]({ cookie: otherToken });
    assert.equal(f.keychainValue, token);
    assert.equal(states(f).at(-1).data.loggedIn, false);
});

test("failed Keychain migration preserves the old credential but never broadcasts it", () => {
    const f = loadMainFixture({ settings: { sessdata: token, opacity: 70 }, keychainWriteFails: true });
    f.sidebarHandlers["sidebar-ready"]({});
    f.sidebarHandlers["update-settings"]({ patch: { opacity: 80 } });
    assert.equal(f.prefs.settings.sessdata, token, "failed migration must not discard the legacy token");
    assert.ok(!JSON.stringify(f.sidebarMessages).includes(token));
    assert.equal(states(f).at(-1).data.loggedIn, false);
});

test("failed preference cleanup keeps logout available until a retry persists removal", async () => {
    const commands = [];
    const f = loadMainFixture({ settings: { sessdata: token }, keychainWriteFails: true,
        preferencesSetFails: true, utilsExec: async (command, args) => {
            commands.push({ command, args: Array.from(args) });
            return { status: 0, stdout: "", stderr: "" };
        } });
    f.sidebarHandlers["sidebar-ready"]({});
    assert.equal(f.prefs.settings.sessdata, token);
    await f.sidebarHandlers["auth-logout"]({});
    assert.equal(f.prefs.settings.sessdata, token);
    assert.equal(states(f).at(-1).data.status, "error");
    assert.equal(states(f).at(-1).data.canLogout, true);
    const deletions = () => commands.filter((entry) => entry.command === "/usr/bin/security" &&
        entry.args[0] === "delete-generic-password");
    assert.equal(deletions().length, 0, "do not delete Keychain while legacy preference cleanup failed");

    f.setPreferenceWritesFail(false);
    await f.sidebarHandlers["auth-logout"]({});
    assert.equal(Object.hasOwn(f.prefs.settings, "sessdata"), false);
    assert.equal(states(f).at(-1).data.status, "anonymous");
    assert.equal(states(f).at(-1).data.canLogout, false);
    assert.equal(deletions().length, 1, "Keychain deletion proceeds only after old preferences are cleared");
});

test("Keychain migration cleanup failure retains legacy tracking after successful auth", async () => {
    const f = loadMainFixture({ settings: { sessdata: token }, preferencesSetFails: true });
    await tick();
    assert.equal(f.keychainValue, token);
    assert.equal(f.prefs.settings.sessdata, token);
    assert.equal(states(f).at(-1).data.loggedIn, true);
    assert.equal(states(f).at(-1).data.canLogout, true);
    assert.match(states(f).at(-1).data.message, /旧版设置.*未清除/);
});

test("failed Keychain write does not claim login success", async () => {
    const f = loadMainFixture({ keychainWriteFails: true });
    await f.sidebarHandlers["auth-cookie"]({ cookie: token });
    assert.equal(f.keychainValue, false);
    assert.equal(states(f).at(-1).data.loggedIn, false);
    assert.match(states(f).at(-1).data.message, /钥匙串/);
});

test("logout cancels pending Cookie validation and deletes only the plugin item", async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const commands = [];
    const f = loadMainFixture({ httpGet: (url) => url.includes("/nav") ? pending : undefined,
        utilsExec: async (cmd, args) => { commands.push({ cmd, args: Array.from(args) }); return { status: 0, stdout: "", stderr: "" }; } });
    const login = f.sidebarHandlers["auth-cookie"]({ cookie: token });
    await f.sidebarHandlers["auth-logout"]({});
    resolve(json({ isLogin: true }));
    await login;
    assert.equal(f.keychainWrites.length, 0);
    const deletion = commands.find((c) => c.cmd === "/usr/bin/security");
    assert.ok(deletion);
    assert.equal(deletion.args[0], "delete-generic-password");
    assert.ok(deletion.args.some((a) => a.includes("cn.waterflames.iina-bilibili-danmaku")));
    assert.ok(!JSON.stringify(commands).includes(token));
    assert.equal(states(f).at(-1).data.loggedIn, false);
});

test("QR flow handles waiting, confirmation, and old cookie-query success", async () => {
    let poll = 0;
    const f = loadMainFixture({
        globals: { setTimeout(fn) { return setTimeout(fn, 0); } },
        httpGet(url) {
            if (url.endsWith("/generate")) return json({ qrcode_key: "a".repeat(32),
                url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=abc" });
            if (url.endsWith("/poll")) {
                poll += 1;
                return json(poll < 3 ? { code: poll === 1 ? 86101 : 86090 }
                    : { code: 0, url: "https://www.bilibili.com/?SESSDATA=" + token });
            }
            return undefined;
        }
    });
    await f.sidebarHandlers["auth-qr-start"]({});
    for (let i = 0; i < 15 && f.keychainValue !== token; i += 1) await tick();
    const qr = f.sidebarMessages.filter((m) => m.name === "auth-qr");
    assert.ok(qr.some((m) => m.data.status === "waiting"));
    assert.ok(qr.some((m) => m.data.status === "scanned"));
    assert.equal(qr.at(-1).data.status, "success");
    assert.equal(f.keychainValue, token);
    assert.ok(!JSON.stringify(f.sidebarMessages).includes(token));
});

test("QR cancel discards in-flight success and stops polling", async () => {
    let resolve;
    let polls = 0;
    const pending = new Promise((done) => { resolve = done; });
    const f = loadMainFixture({
        globals: { setTimeout(fn) { return setTimeout(fn, 0); } },
        httpGet(url) {
            if (url.endsWith("/generate")) return json({ qrcode_key: "a".repeat(32),
                url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=abc" });
            if (url.endsWith("/poll")) { polls += 1; return pending; }
            return undefined;
        }
    });
    await f.sidebarHandlers["auth-qr-start"]({});
    await tick();
    f.sidebarHandlers["auth-qr-cancel"]({});
    resolve(json({ code: 0, url: "https://www.bilibili.com/?SESSDATA=" + token }));
    await tick();
    assert.equal(polls, 1);
    assert.equal(f.keychainWrites.length, 0);
    assert.equal(f.sidebarMessages.filter((m) => m.name === "auth-qr").at(-1).data.status, "cancelled");
});

test("QR ticket exchange only follows allowlisted HTTPS crossDomain URLs", async () => {
    const commands = [];
    const f = loadMainFixture({ utilsExec: async (cmd, args) => {
        if (cmd !== "/usr/bin/curl") return { status: 0, stdout: "", stderr: "" };
        commands.push({ cmd, args: Array.from(args) });
        return { status: 0, stdout: "HTTP/1.1 200 OK\r\nSet-Cookie: SESSDATA=" + token + "; Domain=.bilibili.com; Secure; HttpOnly\r\n\r\n", stderr: "" };
    } });
    const value = await f.context.exchangeQrTicket("https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=safe-ticket");
    assert.equal(value, token);
    assert.ok(commands[0].args.includes("--proto"));
    assert.ok(commands[0].args.includes("--user-agent"), "crossDomain requires a browser UA");
    assert.ok(commands[0].args.includes("--referer"));
    assert.ok(!JSON.stringify(commands).includes("safe-ticket"), "IINA logs argv so ticket must not be passed there");
    assert.equal(f.segmentFiles.size, 0, "temporary ticket config is cleaned up");
    assert.ok(!commands[0].args.includes("--location"), "redirects must be validated before following");
    for (const url of ["http://passport.biligame.com/x/passport-login/web/crossDomain?ticket=x",
        "https://passport.biligame.com.evil.test/x/passport-login/web/crossDomain?ticket=x",
        "https://evil.test/?SESSDATA=" + token,
        "https://passport.biligame.com@evil.test/x/passport-login/web/crossDomain?ticket=x"]) {
        await assert.rejects(() => f.context.exchangeQrTicket(url));
    }
    assert.equal(commands.length, 1);
});

const now = Date.UTC(2026, 9, 2, 4);
const xml = '<i><d p="1,1,25,1,1,0,h,9007199254740993">base</d></i>';
const historyBytes = (ids) => harnessContext.segmentBytes(ids.map((idStr) => ({
    idStr, mode: 1, progress: 1000, content: "history " + idStr
})));
function historyFixture(options = {}) {
    const timers = [];
    const f = loadMainFixture({ now, keychain: token, xmls: [xml], duration: 60,
        globals: { setTimeout(fn, ms) { timers.push(ms); return setTimeout(fn, 0); } }, ...options });
    f.timers = timers;
    return f;
}
const historyStates = (f) => f.sidebarMessages.filter((m) => m.name === "history-progress");

test("history month range is bounded and uses Beijing yesterday", () => {
    const f = historyFixture();
    const plan = f.context.historyMonthPlan(0, now);
    assert.deepEqual(Array.from(plan.months), ["2026-10", "2026-09", "2026-08"]);
    assert.equal(plan.lastDate, "2026-10-01");
    assert.equal(plan.limited, true);
    assert.equal(f.context.historyMonthPlan(Date.UTC(2009, 0, 1) / 1000, now).months.length, 24);
    assert.equal(f.context.historyMonthPlan(Date.UTC(2026, 8, 1) / 1000, now).months.length, 2);
});

test("history loads valid indexed days serially, deduplicates dmid and paces requests", async () => {
    const dates = [];
    const f = historyFixture({ httpGet(url, request) {
        if (url.includes("history/index")) return json(request.params.month === "2026-10"
            ? ["2026-10-01", "2026-10-01", "2026-10-02", "2026-09-01", "garbage"] : ["2026-09-30"]);
        return undefined;
    }, httpDownload(url, destination, request) {
        if (!url.includes("history/")) return new Uint8Array();
        dates.push(request.params.date);
        assert.equal(request.headers.Cookie, "SESSDATA=" + token);
        return historyBytes(["9007199254740993", "9007199254740994", "7"]);
    } });
    await tick();
    const state = f.context.invalidateCurrentLoad();
    const merged = await f.context.runHistoryBackfill(1, xml, state, Date.UTC(2026, 8, 1) / 1000);
    assert.deepEqual(dates, ["2026-10-01", "2026-09-30"]);
    assert.equal((merged.match(/<d p=/g) || []).length, 3);
    assert.ok(f.timers.filter((ms) => ms === 1000).length >= 3);
    assert.equal(historyStates(f).at(-1).data.active, false);
    assert.equal(historyStates(f).at(-1).data.added, 2);
});

test("anonymous load never calls login-only history", async () => {
    const requests = [];
    const f = loadMainFixture({ httpGet(url) { requests.push(url); return undefined; } });
    await f.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    await tick();
    assert.equal(requests.some((u) => u.includes("history/")), false);
});

for (const code of [-101, -412]) {
    test("history API " + code + " stops without discarding current playback", async () => {
        let calls = 0;
        const f = historyFixture({ httpGet(url) {
            if (url.includes("history/index")) { calls += 1; return json(null, code); }
            return undefined;
        } });
        await tick();
        const state = f.context.invalidateCurrentLoad();
        const merged = await f.context.runHistoryBackfill(1, xml, state, 0);
        assert.equal(merged, xml);
        assert.equal(calls, 1);
        assert.match(historyStates(f).at(-1).data.text, /失效|受限/);
        if (code === -101) assert.equal(states(f).at(-1).data.loggedIn, false);
    });
}

test("history retains successful additions after a later malformed response", async () => {
    let calls = 0;
    const f = historyFixture({ httpGet(url) {
        return url.includes("history/index") ? json(["2026-10-01", "2026-09-30"]) : undefined;
    }, httpDownload(url) {
        if (!url.includes("history/")) return new Uint8Array();
        calls += 1;
        return calls === 1 ? historyBytes(["8"]) : Uint8Array.from([0x0a, 0xff]);
    } });
    await tick();
    const merged = await f.context.runHistoryBackfill(1, xml, f.context.invalidateCurrentLoad(), 0);
    assert.match(merged, /history 8/);
    assert.match(historyStates(f).at(-1).data.text, /部分|中止/);
});

test("history cancellation drops an in-flight response and never requests another day", async () => {
    let resolve;
    let calls = 0;
    const pending = new Promise((done) => { resolve = done; });
    const f = historyFixture({ httpGet(url) {
        return url.includes("history/index") ? json(["2026-10-01"]) : undefined;
    }, httpDownload(url) {
        if (!url.includes("history/")) return new Uint8Array();
        calls += 1;
        return pending;
    } });
    await tick();
    const result = f.context.runHistoryBackfill(1, xml, f.context.invalidateCurrentLoad(), 0);
    for (let i = 0; i < 10 && calls === 0; i += 1) await tick();
    f.sidebarHandlers["history-cancel"]({});
    resolve(historyBytes(["late"]));
    assert.equal(await result, xml);
    assert.equal(calls, 1);
    assert.equal(f.segmentFiles.size, 0);
    assert.equal(historyStates(f).at(-1).data.active, false);
});

test("source switch invalidates history completion and suppresses stale progress", async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const f = historyFixture({ httpGet(url) {
        return url.includes("history/index") ? pending : undefined;
    } });
    await tick();
    const state = f.context.invalidateCurrentLoad();
    const result = f.context.runHistoryBackfill(1, xml, state, 0);
    f.context.invalidateCurrentLoad();
    const count = f.sidebarMessages.length;
    resolve(json(["2026-10-01"]));
    await result;
    assert.equal(f.sidebarMessages.length, count);
    assert.equal(f.downloadRequests.length, 0);
});

test("authenticated XML denial retries anonymous without blocking source loading", async () => {
    const cookies = [];
    const f = historyFixture({ httpGet(url, request) {
        if (!url.includes("list.so")) return undefined;
        cookies.push(request.headers.Cookie || "");
        return request.headers.Cookie ? { statusCode: 403, text: "denied" }
            : { statusCode: 200, text: xml };
    } });
    await tick();
    await f.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    assert.deepEqual(cookies, ["SESSDATA=" + token, ""]);
    await tick();
    assert.ok(f.overlayMessages.some((m) => m.name === "stream-start"));
});

test("invalid Cookie submission cancels QR rather than leaving hidden polling active", async () => {
    let polls = 0;
    const f = loadMainFixture({ globals: { setTimeout(fn) { return setTimeout(fn, 0); } }, httpGet(url) {
        if (url.endsWith("/generate")) return json({ qrcode_key: "a".repeat(32),
            url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=abc" });
        if (url.endsWith("/poll")) { polls += 1; return json({ code: 86101 }); }
        return undefined;
    } });
    await f.sidebarHandlers["auth-qr-start"]({});
    await f.sidebarHandlers["auth-cookie"]({ cookie: "buvid3=only" });
    const count = polls;
    await tick();
    await tick();
    assert.equal(polls, count);
});

test("login waits for pending scoped logout deletion before saving a new token", async () => {
    let finishDeletion;
    const pending = new Promise((done) => { finishDeletion = done; });
    const f = loadMainFixture({ utilsExec(cmd) {
        return cmd === "/usr/bin/security" ? pending : Promise.resolve({ status: 0, stdout: "", stderr: "" });
    } });
    const exit = f.sidebarHandlers["auth-logout"]({});
    const login = f.sidebarHandlers["auth-cookie"]({ cookie: token });
    await tick();
    assert.equal(f.keychainWrites.length, 0, "must not write while deletion is in flight");
    finishDeletion({ status: 0, stdout: "", stderr: "" });
    await Promise.all([exit, login]);
    assert.equal(f.keychainValue, token);
    assert.equal(states(f).at(-1).data.loggedIn, true);
});

test("startup validation never activates unverified credentials or history", async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const requests = [];
    const f = historyFixture({ httpGet(url, request) {
        requests.push({ url, cookie: request.headers.Cookie || "" });
        if (url.includes("/nav")) return pending;
        if (url.includes("history/index")) return json(null);
        return undefined;
    } });
    await f.sidebarHandlers["load-source"]({ text: "BV1xx411c7mD" });
    assert.equal(states(f).at(-1).data.loggedIn, false);
    assert.equal(requests.some((r) => r.url.includes("history/index")), false);
    assert.equal(requests.find((r) => r.url.includes("list.so")).cookie, "");
    resolve(json(null, -101));
    await tick();
    f.sidebarHandlers["sidebar-ready"]({});
    assert.equal(historyStates(f).at(-1).data.active, false);
    assert.equal(states(f).at(-1).data.status, "expired");
    assert.equal(states(f).at(-1).data.canLogout, true, "expired persisted credential can still be deleted");
});

test("failed logout deletion permits retry and never claims persisted token removed", async () => {
    const f = historyFixture({ utilsExec: async (cmd) => ({ status: cmd === "/usr/bin/security" ? 1 : 0, stdout: "", stderr: "" }) });
    await tick();
    await f.sidebarHandlers["auth-logout"]({});
    assert.equal(states(f).at(-1).data.loggedIn, false);
    assert.equal(states(f).at(-1).data.canLogout, true);
    assert.equal(states(f).at(-1).data.status, "error");
});

test("late successful startup validation cannot restore a logged-out account", async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const f = historyFixture({ httpGet: (url) => url.includes("/nav") ? pending : undefined,
        utilsExec: async () => ({ status: 0, stdout: "", stderr: "" }) });
    await f.sidebarHandlers["auth-logout"]({});
    resolve(json({ isLogin: true }));
    await tick();
    assert.equal(states(f).at(-1).data.loggedIn, false);
    assert.equal(states(f).at(-1).data.status, "anonymous");
    assert.equal(f.keychainWrites.length, 0);
});

test("history request budget includes month indexes and strictly stops at 400", async () => {
    let requests = 0;
    const f = historyFixture({ httpGet(url, request) {
        if (!url.includes("history/index")) return undefined;
        requests += 1;
        const date = new Date(request.params.month + "-01T00:00:00Z");
        const days = new Date(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getDate();
        return json(Array.from({ length: days }, (_, i) => request.params.month + "-" + String(i + 1).padStart(2, "0")));
    }, httpDownload(url) {
        if (url.includes("history/")) requests += 1;
        return new Uint8Array();
    } });
    await tick();
    await f.context.runHistoryBackfill(1, xml, f.context.invalidateCurrentLoad(), Date.UTC(2009, 0, 1) / 1000);
    assert.equal(requests, 400);
    assert.match(historyStates(f).at(-1).data.text, /400/);
    assert.equal(historyStates(f).at(-1).data.active, false);
});

test("QR expiry reports a retryable state without activating any credential", async () => {
    const f = loadMainFixture({ globals: { setTimeout(fn) { return setTimeout(fn, 0); } }, httpGet(url) {
        if (url.endsWith("/generate")) return json({ qrcode_key: "a".repeat(32),
            url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=abc" });
        if (url.endsWith("/poll")) return json({ code: 86038 });
        return undefined;
    } });
    await f.sidebarHandlers["auth-qr-start"]({});
    await tick();
    await tick();
    assert.equal(f.sidebarMessages.filter((m) => m.name === "auth-qr").at(-1).data.status, "expired");
    assert.equal(f.keychainWrites.length, 0);
});
