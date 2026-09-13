importScripts("danmaku-parser.js");

let activeStreamId = null;
let parser = null;

function report(type, streamId, stats) {
    self.postMessage(Object.assign({ type, streamId }, stats));
}

function startStream(streamId) {
    activeStreamId = streamId;
    parser = BiliDanmakuParser.createStreamingParser((comments, stats) => {
        report("comments", streamId, {
            comments,
            parsed: stats.parsed,
            accepted: stats.accepted,
            skipped: stats.skipped
        });
    }, 200);
    report("progress", streamId, parser.stats());
}

self.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "start") {
        startStream(data.streamId);
        return;
    }
    if (data.streamId !== activeStreamId || !parser) return;
    try {
        if (data.type === "chunk") {
            const stats = parser.push(data.chunk || "");
            report("progress", data.streamId, stats);
        } else if (data.type === "end") {
            const stats = parser.finish();
            report("complete", data.streamId, stats);
            parser = null;
        } else if (data.type === "cancel") {
            parser = null;
            activeStreamId = null;
        }
    } catch (error) {
        report("error", data.streamId, {
            message: String((error && error.message) || error)
        });
        parser = null;
    }
};
