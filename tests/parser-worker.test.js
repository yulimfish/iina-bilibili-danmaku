const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadWorker() {
    const messages = [];
    const context = { console, setTimeout };
    context.self = context;
    context.postMessage = (message) => messages.push(message);
    context.importScripts = (name) => {
        const source = fs.readFileSync(
            path.join(__dirname, "..", "overlay", name), "utf8"
        );
        vm.runInContext(source, context);
    };
    vm.createContext(context);
    const workerSource = fs.readFileSync(
        path.join(__dirname, "..", "overlay", "parser-worker.js"), "utf8"
    );
    vm.runInContext(workerSource, context);
    return { context, messages };
}

test("worker parses only the current stream and reports completion", () => {
    const { context, messages } = loadWorker();

    context.onmessage({ data: { type: "start", streamId: 7 } });
    context.onmessage({ data: {
        type: "chunk", streamId: 6, chunk: '<d p="9,1,25,1">stale</d>'
    } });
    context.onmessage({ data: {
        type: "chunk", streamId: 7, chunk: '<d p="1,1,25,1,1,0,h,1">hel'
    } });
    context.onmessage({ data: {
        type: "chunk", streamId: 7, chunk: 'lo</d>'
    } });
    context.onmessage({ data: { type: "end", streamId: 7 } });

    const commentMessages = messages.filter((message) => message.type === "comments");
    assert.equal(commentMessages.length, 1);
    assert.equal(commentMessages[0].comments[0].text, "hello");
    assert.deepEqual(JSON.parse(JSON.stringify(messages.find((message) =>
        message.type === "complete"))), {
        type: "complete", streamId: 7, parsed: 1, accepted: 1, skipped: 0
    });
});

test("worker drops queued input after cancellation", () => {
    const { context, messages } = loadWorker();

    context.onmessage({ data: { type: "start", streamId: 11 } });
    context.onmessage({ data: { type: "cancel", streamId: 11 } });
    context.onmessage({ data: {
        type: "chunk", streamId: 11, chunk: '<d p="1,1,25,1,1,0,h,1">cancelled</d>'
    } });
    context.onmessage({ data: { type: "end", streamId: 11 } });

    assert.equal(messages.some((message) => message.type === "comments"), false);
    assert.equal(messages.some((message) => message.type === "complete"), false);
});

test("worker emits out-of-order records before stream completion", () => {
    const { context, messages } = loadWorker();
    const xml =
        '<d p="3,1,25,1,1,0,c,3">three</d>' +
        '<d p="1,1,25,1,1,0,a,1">one</d>' +
        '<d p="2,1,25,1,1,0,b,2">two</d>';

    context.onmessage({ data: { type: "start", streamId: 12 } });
    context.onmessage({ data: { type: "chunk", streamId: 12, chunk: xml } });
    assert.equal(messages.some((message) => message.type === "comments"), true);
    context.onmessage({ data: { type: "end", streamId: 12 } });

    const comments = messages
        .filter((message) => message.type === "comments")
        .flatMap((message) => message.comments)
        .map((comment) => comment.text);
    assert.deepEqual(JSON.parse(JSON.stringify(comments)), ["three", "one", "two"]);
    const lastCommentIndex = messages.reduce((index, message, currentIndex) =>
        message.type === "comments" ? currentIndex : index, -1);
    const completeIndex = messages.findIndex((message) => message.type === "complete");
    assert.equal(completeIndex > lastCommentIndex, true);
});

test("worker keeps comment batches bounded before completion", () => {
    const { context, messages } = loadWorker();
    const xml = Array.from({ length: 401 }, (_, index) =>
        `<d p="${index},1,25,1,1,0,h,${index}">${index}</d>`
    ).join("");

    context.onmessage({ data: { type: "start", streamId: 18 } });
    context.onmessage({ data: { type: "chunk", streamId: 18, chunk: xml } });
    context.onmessage({ data: { type: "end", streamId: 18 } });

    const commentMessages = messages.filter((message) => message.type === "comments");
    assert.deepEqual(commentMessages.map((message) => message.comments.length), [200, 200, 1]);
    const lastCommentIndex = messages.reduce((index, message, currentIndex) =>
        message.type === "comments" ? currentIndex : index, -1);
    const completeIndex = messages.findIndex((message) => message.type === "complete");
    assert.equal(completeIndex > lastCommentIndex, true);
});
