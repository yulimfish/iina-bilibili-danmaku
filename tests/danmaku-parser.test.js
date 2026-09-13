const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseCommentToken,
    createStreamingParser
} = require("../overlay/danmaku-parser.js");

test("parses supported Bilibili fields into CCL data", () => {
    const comment = parseCommentToken(
        '<d p="1.25,1,30,16711680,1700000000,0,hash,123">hello</d>'
    );

    assert.deepEqual(comment, {
        stime: 1250,
        size: 30,
        color: 16711680,
        mode: 1,
        date: 1700000000,
        pool: 0,
        position: "absolute",
        dbid: 123,
        hash: "hash",
        border: false,
        text: "hello"
    });
});

test("parses modern 9-parameter records with 64-bit dbid values", () => {
    const comment = parseCommentToken(
        '<d p="1350.23800,5,25,41194,1719800846,0,ee45ef1c,1618030297100649984,10">前方富冈义勇大型语言艺术现场</d>'
    );

    assert.equal(comment.stime, 1350238);
    assert.equal(comment.mode, 5);
    assert.equal(comment.size, 25);
    assert.equal(comment.color, 41194);
    assert.equal(comment.date, 1719800846);
    assert.equal(comment.pool, 0);
    assert.equal(comment.hash, "ee45ef1c");
    assert.equal(comment.dbid, 1618030297100649984);
    assert.equal(comment.text, "前方富冈义勇大型语言艺术现场");
});

test("decodes XML entities and normalizes Bilibili newlines", () => {
    const comment = parseCommentToken(
        '<d p="2,4,25,16777215,1,0,h,2">&lt;hi&gt;&amp;one/n two\\ntwo\r\nthree</d>'
    );

    assert.equal(comment.text, "<hi>&one\n two\ntwo\nthree");
    assert.equal(parseCommentToken('<d p="2,1,25,1,1,0,h,2">■</d>').text, "█");
});

test("discards unsupported modes and malformed records", () => {
    assert.equal(parseCommentToken('<d p="1,7,25,1,1,0,h,1">advanced</d>'), null);
    assert.equal(parseCommentToken('<d p="1,8,25,1,1,0,h,1">code</d>'), null);
    assert.equal(parseCommentToken('<d p="1,9,25,1,1,0,h,1">bas</d>'), null);
    assert.equal(parseCommentToken('<d p="1,0,25,1,1,0,h,1">unknown</d>'), null);
    assert.equal(parseCommentToken('<d p="1,3,25,1,1,0,h,1">unknown</d>'), null);
    assert.equal(parseCommentToken('<d p="1,10,25,1,1,0,h,1">unknown</d>'), null);
    assert.equal(parseCommentToken('<d p="1,17,25,1,1,0,h,1">unknown</d>'), null);
    assert.equal(parseCommentToken('<d p="bad,1,25,1">bad</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25oops,1">bad</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1">bad</x></d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1" broken=oops>x</d>'), null);
    assert.equal(parseCommentToken('<D p="1,1,25,1">upper</d>'), null);
    assert.equal(parseCommentToken('<d P="1,1,25,1,1,0,h,1">upper</d>'), null);
    assert.equal(parseCommentToken("<d p='1,1,25,1,1,0,h,1'>quote</d>"), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1">upper</D>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,1">space</d >'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1"><foo>x</foo></d>'), null);
    assert.equal(parseCommentToken(
        '<d p="1,1,25,1"><d p="2,1,25,1">nested</d></d>'
    ), null);
    assert.equal(parseCommentToken('<d p="1e308,1,25,1">too large</d>'), null);
    assert.equal(parseCommentToken('<d p="1e305,1,25,1">too precise</d>'), null);
    assert.equal(parseCommentToken('<d p="-0.0001,1,25,1">negative</d>'), null);
    assert.equal(parseCommentToken('<d p="1,-1,25,1,1,0,h,1">negative mode</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,0,1,1,0,h,1">zero size</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,-1,1,1,0,h,1">negative size</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,-1,1,0,h,1">negative color</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,bad,0,h,1">bad date</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,bad,h,1">bad pool</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,bad">bad dbid</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,1">raw & amp</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h&x,1">raw p amp</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,1">&AMP;</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,1">&#0;</d>'), null);
    assert.equal(parseCommentToken('<d p="1,1,25,1,1,0,h,1">&#x110000;</d>'), null);
    assert.equal(parseCommentToken("not a comment"), null);
});

test("emits a partial batch after each input chunk", () => {
    const batches = [];
    const parser = createStreamingParser((batch) => batches.push(batch), 200);

    parser.push('<d p="1,1,25,1,1,0,h,1">first</d>');

    assert.equal(batches.length, 1);
    assert.equal(batches[0][0].text, "first");
});

test("handles records split at arbitrary chunk boundaries", () => {
    const xml =
        '<i><d p="0.5,1,25,1,1,0,a,1">a&amp;b</d>' +
        '<d p="1.5,5,25,2,1,0,b,2">top</d></i>';
    const expected = [
        { stime: 500, size: 25, color: 1, mode: 1, date: 1, pool: 0,
          position: "absolute", dbid: 1, hash: "a", border: false, text: "a&b" },
        { stime: 1500, size: 25, color: 2, mode: 5, date: 1, pool: 0,
          position: "absolute", dbid: 2, hash: "b", border: false, text: "top" }
    ];
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 2);

    for (let i = 0; i < xml.length; i += 1) {
        parser.push(xml.slice(i, i + 1));
    }
    parser.finish();

    assert.deepEqual(output, expected);
    assert.deepEqual(parser.stats(), { parsed: 2, accepted: 2, skipped: 0 });
});

test("flushes complete trailing records and ignores incomplete input", () => {
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 1);

    parser.push('<d p="3,1,25,1,1,0,h,3">complete</d><d p="4,1,25');
    parser.finish();

    assert.equal(output.length, 1);
    assert.equal(output[0].text, "complete");
    assert.deepEqual(parser.stats(), { parsed: 1, accepted: 1, skipped: 1 });
});

test("resynchronizes after a malformed record before the next valid record", () => {
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 200);

    parser.push(
        '<d p="1,1,25oops,1">broken</d>' +
        '<d p="2,1,25,1,1,0,h,2">valid</d>'
    );
    parser.finish();

    assert.deepEqual(output.map((comment) => comment.text), ["valid"]);
    assert.deepEqual(parser.stats(), { parsed: 2, accepted: 1, skipped: 1 });
});

test("resynchronizes when a malformed opener consumes the next opener", () => {
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 200);

    parser.push('<d p="1,1,25,1<d p="2,1,25,1,1,0,h,2">valid</d>');
    parser.finish();

    assert.deepEqual(output.map((comment) => comment.text), ["valid"]);
    assert.deepEqual(parser.stats(), { parsed: 2, accepted: 1, skipped: 1 });
});

test("does not accept a nested d record as an outer comment", () => {
    const output = [];
    const parser = createStreamingParser((batch) => output.push(...batch), 200);

    parser.push('<d p="1,1,25,1"><d p="2,1,25,1">nested</d></d>');
    parser.finish();

    assert.deepEqual(output, []);
    assert.deepEqual(parser.stats(), { parsed: 1, accepted: 0, skipped: 1 });
});

test("never emits a batch larger than the configured size", () => {
    const batches = [];
    const parser = createStreamingParser((batch) => batches.push(batch), 2);
    parser.push(
        '<d p="1,1,25,1,1,0,a,1">a</d>' +
        '<d p="2,1,25,1,1,0,b,2">b</d>' +
        '<d p="3,1,25,1,1,0,c,3">c</d>'
    );
    parser.finish();

    assert.deepEqual(batches.map((batch) => batch.length), [2, 1]);
});
