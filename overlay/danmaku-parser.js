(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.BiliDanmakuParser = factory();
    }
}(typeof self !== "undefined" ? self : this, function () {
    const DEFAULT_BATCH_SIZE = 200;

    function decodeXmlEntities(text) {
        return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/g,
            (match, entity) => {
                if (entity === "amp") return "&";
                if (entity === "lt") return "<";
                if (entity === "gt") return ">";
                if (entity === "quot") return '"';
                if (entity === "apos") return "'";
                const code = entity.startsWith("#x")
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            });
    }

    function isValidXmlCodePoint(code) {
        return code === 0x9 || code === 0xa || code === 0xd ||
            (code >= 0x20 && code <= 0xd7ff) ||
            (code >= 0xe000 && code <= 0xfffd) ||
            (code >= 0x10000 && code <= 0x10ffff);
    }

    function hasInvalidXmlEntities(text) {
        let cursor = 0;
        while (cursor < text.length) {
            const start = text.indexOf("&", cursor);
            if (start < 0) return false;
            const end = text.indexOf(";", start + 1);
            if (end < 0) return true;
            const entity = text.slice(start + 1, end);
            if (entity === "amp" || entity === "lt" || entity === "gt" ||
                entity === "quot" || entity === "apos") {
                cursor = end + 1;
                continue;
            }
            let code = null;
            if (/^#x[0-9a-f]+$/.test(entity)) {
                code = parseInt(entity.slice(2), 16);
            } else if (/^#\d+$/.test(entity)) {
                code = parseInt(entity.slice(1), 10);
            }
            if (code === null || !isValidXmlCodePoint(code)) return true;
            cursor = end + 1;
        }
        return false;
    }

    function parseInteger(value) {
        const normalized = String(value || "");
        if (!/^\d+$/.test(normalized)) {
            return null;
        }
        const parsed = Number(normalized);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    function parseCommentToken(token) {
        const opening = /^<d (p="[^"]*")>/.exec(token);
        const closing = /<\/d>$/.exec(token);
        if (!opening || !closing) return null;

        const pMatch = /^p="([^"]*)"$/.exec(opening[1]);
        if (!pMatch) return null;
        if (pMatch[1].includes("<") || hasInvalidXmlEntities(pMatch[1])) return null;
        const params = decodeXmlEntities(pMatch[1]).split(",");
        if (params.length < 8) return null;

        const rawTime = String(params[0] || "");
        if (!/^\d+(?:\.\d+)?$/.test(rawTime)) {
            return null;
        }
        const time = Number(rawTime);
        const mode = parseInteger(params[1]);
        const size = parseInteger(params[2]);
        const color = parseInteger(params[3]);
        if (!Number.isFinite(time) || mode === null || size === null || color === null ||
            size <= 0 || color > 0xffffff) {
            return null;
        }
        if (![1, 2, 4, 5, 6].includes(mode)) return null;

        const contentStart = opening[0].length;
        const contentEnd = token.length - closing[0].length;
        const rawText = token.slice(contentStart, contentEnd);
        if (rawText.includes("<") || hasInvalidXmlEntities(rawText)) {
            return null;
        }
        const stime = time * 1000;
        const normalizedStime = Math.round(stime);
        if (!Number.isSafeInteger(normalizedStime) || normalizedStime < 0) return null;
        const text = decodeXmlEntities(rawText.replace(/<[^>]*>/g, ""))
            .replace(/(\/n|\\n|\r\n|\n|\r)/g, "\n")
            .replace(/\u25a0/g, "\u2588");
        const date = parseInteger(params[4]);
        const pool = parseInteger(params[5]);
        const rawDbid = String(params[7] || "");
        if (date === null || pool === null || !/^\d+$/.test(rawDbid)) return null;
        // dbid is a 64-bit id that may exceed Number.MAX_SAFE_INTEGER; keep the
        // same parseInt semantics as CommentCoreLibrary.
        const dbid = parseInt(rawDbid, 10);
        const comment = {
            stime: normalizedStime,
            size: size,
            color: color,
            mode: mode,
            date: date,
            pool: pool,
            position: "absolute",
            hash: params[6] || "",
            border: false,
            text: text
        };
        comment.dbid = dbid;
        return comment;
    }

    function createStreamingParser(onBatch, batchSize) {
        if (typeof onBatch !== "function") {
            throw new TypeError("onBatch must be a function");
        }
        const state = {
            buffer: "",
            batch: [],
            batchSize: Number.isInteger(batchSize) && batchSize > 0
                ? batchSize : DEFAULT_BATCH_SIZE,
            parsed: 0,
            accepted: 0,
            skipped: 0
        };
        const stats = () => ({
            parsed: state.parsed,
            accepted: state.accepted,
            skipped: state.skipped
        });
        const emit = () => {
            if (state.batch.length === 0) return;
            const batch = state.batch;
            state.batch = [];
            onBatch(batch, stats());
        };
        const consume = (final) => {
            while (state.buffer.length > 0) {
                const start = state.buffer.search(/<d\b/i);
                if (start < 0) {
                    state.buffer = final ? "" : state.buffer.slice(-1);
                    return;
                }
                if (start > 0) state.buffer = state.buffer.slice(start);
                const openEnd = state.buffer.indexOf(">");
                if (openEnd < 0) {
                    if (final) state.buffer = "";
                    return;
                }
                const nestedOpening = state.buffer.slice(2, openEnd).search(/<d\b/i);
                if (nestedOpening >= 0) {
                    state.parsed += 1;
                    state.skipped += 1;
                    state.buffer = state.buffer.slice(2 + nestedOpening);
                    continue;
                }
                const content = state.buffer.slice(openEnd + 1);
                const nestedStart = content.search(/<d\b/i);
                const close = /<\/d\s*>/i.exec(content);
                if (nestedStart >= 0 && (!close || nestedStart < close.index)) {
                    state.parsed += 1;
                    state.skipped += 1;
                    const nestedOffset = openEnd + 1 + nestedStart;
                    const nestedClose = /<\/d\s*>/i.exec(state.buffer.slice(nestedOffset));
                    if (nestedClose) {
                        state.buffer = state.buffer.slice(
                            nestedOffset + nestedClose.index + nestedClose[0].length
                        );
                    } else {
                        state.buffer = "";
                    }
                    continue;
                }
                if (!close) {
                    if (final) state.buffer = "";
                    return;
                }
                const end = openEnd + 1 + close.index + close[0].length;
                const token = state.buffer.slice(0, end);
                state.buffer = state.buffer.slice(end);
                state.parsed += 1;
                const comment = parseCommentToken(token);
                if (!comment) {
                    state.skipped += 1;
                    continue;
                }
                state.accepted += 1;
                state.batch.push(comment);
                if (state.batch.length >= state.batchSize) emit();
            }
        };
        return {
            push(chunk) {
                if (typeof chunk !== "string" || chunk.length === 0) return stats();
                state.buffer += chunk;
                consume(false);
                emit();
                return stats();
            },
            finish() {
                const hadIncompleteInput = /<d\b/i.test(state.buffer);
                consume(true);
                if (hadIncompleteInput) state.skipped += 1;
                state.buffer = "";
                emit();
                return stats();
            },
            stats
        };
    }

    return { DEFAULT_BATCH_SIZE, parseCommentToken, createStreamingParser };
}));
