/**
 * Transparent response compression for large JSON payloads.
 *
 * Long sessions make `session.history` responses megabytes of JSON; on a
 * phone that is a slow, data-hungry transfer. This module patches
 * `http.ServerResponse.prototype` (process-wide, restored on dispose) so any
 * JSON response the host serves — the harness's own `/api/*` routes included —
 * is compressed when the client accepts it:
 *
 * - The client's `Accept-Encoding` picks the codec: `br` (brotli, quality 6)
 *   preferred, `gzip` fallback.
 * - Only JSON responses of at least MIN_JSON_BYTES are compressed; small
 *   JSON and every other content type (HTML, static assets, ZIP, SSE streams)
 *   pass through byte-identical with the original headers.
 * - The response header write is deferred until the body is known, so the
 *   decision (compress or not) is made on the actual size, and `Content-Length`
 *   always matches what is sent. Non-JSON responses call the original
 *   `writeHead` immediately and are never touched.
 *
 * The browser's fetch decompresses transparently, so no client change is
 * needed. SSE (`text/event-stream`) is intentionally left uncompressed: it is
 * a continuous stream and the /api bridge never buffers it.
 *
 * Ported from community fork wzxmt-zhc/dsh-web-mobile (v2.5.0).
 */
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { ServerResponse as NodeServerResponse } from 'node:http';
/** Only payloads at least this large are worth compressing. */
const MIN_JSON_BYTES = 4 * 1024;
/** Brotli quality: 6 balances size and CPU for large JSON (17MB → ~1MB). */
const BROTLI_QUALITY = 6;
/** Per-response state; only present while a JSON response is being deferred. */
const deferred = new WeakMap();
/** Choose the codec the client accepts; `br` outranks `gzip`. */
function pickEncoding(res) {
    const accepted = res.req?.headers['accept-encoding'] ?? '';
    if (/\bbr\b/.test(accepted))
        return 'br';
    if (/\bgzip\b/.test(accepted))
        return 'gzip';
    return null;
}
/**
 * Find a header value regardless of the caller's key casing. The patch sees
 * the RAW writeHead argument (before Node lowercases), and HTTP header names
 * are case-insensitive — a caller may pass `Content-Type` or `content-type`.
 * (Case-insensitivity fix ported from community fork wzxmt-zhc/dsh-web-mobile.)
 */
export function headerValue(headers, name) {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name)
            return String(headers[key]);
    }
    return undefined;
}
/** Whether a response warrants deferred (potentially compressed) handling. */
export function isDeferrable(headers) {
    if (headerValue(headers, 'content-encoding') !== undefined)
        return false;
    const contentType = headerValue(headers, 'content-type') ?? '';
    return contentType.includes('json');
}
/** Append the Accept-Encoding Vary token without clobbering an existing Vary. */
export function varyWithAcceptEncoding(headers) {
    const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'vary');
    if (existingKey === undefined) {
        headers['vary'] = 'Accept-Encoding';
    }
    else {
        headers[existingKey] = `${String(headers[existingKey])}, Accept-Encoding`;
    }
}
/** Extract the trailing callback from an `end`/`write` rest-arg list, if any. */
function trailingCallback(rest) {
    for (let i = rest.length - 1; i >= 0; i--) {
        if (typeof rest[i] === 'function')
            return rest[i];
        // Only a trailing run of callback-compatible args counts; stop at data.
        break;
    }
    return undefined;
}
/**
 * Call the ORIGINAL `end` with at most a data buffer and the trailing
 * callback. Encoding arguments from the caller's original signature are
 * dropped: the deferred body has already been buffered/compressed, so any
 * encoding string in `rest` must never be replayed as a body chunk.
 */
function invokeEnd(res, origEnd, data, callback) {
    if (data !== undefined) {
        return callback === undefined
            ? origEnd.call(res, data)
            : origEnd.call(res, data, callback);
    }
    return callback === undefined ? origEnd.call(res) : origEnd.call(res, callback);
}
/**
 * Build the callback that fires once the deferred body is committed: the
 * queued `write` callbacks first (in call order, mirroring Node flushing each
 * buffered chunk in turn), then the `end` callback. Returns a thunk so the
 * call site can decide *when* the body has actually been written.
 */
function invokeEndCallback(rest, pending) {
    const queued = pending.writeCallbacks;
    const endCallback = trailingCallback(rest);
    return () => {
        for (const cb of queued) {
            try {
                cb();
            }
            catch {
                // A write callback throwing must not break the response teardown;
                // node surfaces such errors on the stream, not in our patch.
            }
        }
        return endCallback;
    };
}
function bufferChunk(pending, chunk) {
    if (typeof chunk === 'string')
        pending.chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array)
        pending.chunks.push(Buffer.from(chunk));
    else if (chunk !== null && chunk !== undefined)
        pending.chunks.push(Buffer.from(String(chunk)));
}
/** Replay the stored writeHead args with a replacement headers object. */
function writeHeadWith(res, origWriteHead, pending, headers) {
    const args = pending.writeHeadArgs.slice();
    if (typeof args[1] === 'string')
        args[2] = headers;
    else
        args[1] = headers;
    // Keep the receiver: node's writeHead reads this._header etc.
    return origWriteHead.apply(res, args);
}
/**
 * Snapshot the headers the response already carries via `setHeader` calls,
 * merged under any headers passed directly to `writeHead` (writeHead wins on
 * a key clash, matching Node's own precedence).
 *
 * Node's `writeHead(status)` with no headers argument is extremely common:
 * the caller sets headers with `res.setHeader(...)`. The patch previously
 * read ONLY the writeHead argument, so that path looked like "no headers"
 * and was passed through uncompressed — silently disabling compression for
 * every setHeader-style handler. This merge closes that gap.
 */
function snapshotHeaders(res, writeHeadArgs) {
    const merged = {};
    const existing = res.getHeaders();
    for (const key of Object.keys(existing)) {
        const value = existing[key];
        if (value !== undefined)
            merged[key] = value;
    }
    const raw = typeof writeHeadArgs[1] === 'string' ? writeHeadArgs[2] : writeHeadArgs[1];
    if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const key of Object.keys(raw)) {
            merged[key] = raw[key];
        }
    }
    return merged;
}
/**
 * Install the compression patch on http.ServerResponse.prototype.
 *
 * Idempotent: a second call while a patch is live returns a no-op disposer
 * instead of wrapping the wrapper. Without the guard, two live installs each
 * capture the other's patched method as their `orig`, and because each
 * disposer only restores when the prototype still holds ITS OWN function, a
 * non-LIFO dispose order leaves the prototype patched forever (verified by
 * probe: non-LIFO unwinding of a double install never returns to pristine).
 * The live disposer owns the restore; a repeated install is a no-op.
 *
 * @returns disposer restoring the original methods (plugin reload safety).
 */
let activeCompressionDisposer = null;
export function installResponseCompression() {
    if (activeCompressionDisposer !== null)
        return () => { };
    const proto = NodeServerResponse.prototype;
    // Capture the originals under the simple signatures the wrappers use; the
    // real overloaded implementations are restored unchanged on dispose.
    const origWriteHead = proto.writeHead;
    const origWrite = proto.write;
    const origEnd = proto.end;
    function patchedWriteHead(...args) {
        // Headers may arrive as a writeHead argument OR have been set earlier via
        // res.setHeader(...). Node's writeHead(status) no-header form is common;
        // read BOTH so a setHeader-only handler is still deferrable.
        const headers = snapshotHeaders(this, args);
        if (!isDeferrable(headers)) {
            return origWriteHead.apply(this, args);
        }
        const encoding = pickEncoding(this);
        if (encoding === null) {
            return origWriteHead.apply(this, args);
        }
        // Hold the header write until the body size is known (see module doc).
        // Node's own headers have already been merged into the snapshot; the
        // replay call passes the snapshot back so nothing set via setHeader is
        // lost when writeHeadArguments omitted it.
        deferred.set(this, { writeHeadArgs: args, headers, encoding, chunks: [], writeCallbacks: [] });
        return this;
    }
    function patchedWrite(chunk, ...rest) {
        const pending = deferred.get(this);
        if (pending !== undefined) {
            bufferChunk(pending, chunk);
            const callback = trailingCallback(rest);
            if (callback !== undefined)
                pending.writeCallbacks.push(callback);
            return true;
        }
        return origWrite.apply(this, [chunk, ...rest]);
    }
    function patchedEnd(chunk, ...rest) {
        const pending = deferred.get(this);
        if (pending === undefined) {
            return chunk === undefined
                ? origEnd.apply(this, rest)
                : origEnd.apply(this, [chunk, ...rest]);
        }
        deferred.delete(this);
        if (chunk !== undefined)
            bufferChunk(pending, chunk);
        const body = Buffer.concat(pending.chunks);
        // Only the trailing callback survives a deferred end: the body is written
        // in one shot below, so any encoding argument in `rest` is consumed here.
        // Passing `rest` through verbatim would push an encoding string ('utf8')
        // into the stream as a second body chunk and corrupt the response.
        const callback = invokeEndCallback(rest, pending);
        // Small or empty JSON: replay the ORIGINAL header write and body verbatim
        // (no Content-Encoding, original Content-Length intact).
        if (body.byteLength < MIN_JSON_BYTES) {
            writeHeadWith(this, origWriteHead, pending, pending.headers);
            return invokeEnd(this, origEnd, body.byteLength === 0 ? undefined : body, callback());
        }
        // Large JSON: compress and rewrite the length-bearing headers.
        const compressed = pending.encoding === 'br'
            ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
            : gzipSync(body, { level: 6 });
        const headers = { ...pending.headers };
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-length')
                delete headers[key];
        }
        headers['content-encoding'] = pending.encoding;
        headers['content-length'] = compressed.byteLength;
        varyWithAcceptEncoding(headers);
        writeHeadWith(this, origWriteHead, pending, headers);
        origWrite.call(this, compressed);
        return invokeEnd(this, origEnd, undefined, callback());
    }
    proto.writeHead = patchedWriteHead;
    proto.write = patchedWrite;
    proto.end = patchedEnd;
    const dispose = () => {
        if (proto.writeHead === patchedWriteHead)
            proto.writeHead = origWriteHead;
        if (proto.write === patchedWrite)
            proto.write = origWrite;
        if (proto.end === patchedEnd)
            proto.end = origEnd;
        if (activeCompressionDisposer === dispose)
            activeCompressionDisposer = null;
    };
    activeCompressionDisposer = dispose;
    return dispose;
}
//# sourceMappingURL=compress.js.map