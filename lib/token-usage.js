/**
 * dsh-web-mobile, host half: lifetime token accounting.
 *
 * Folds the durable session corpus into ONE figure: every token the harness
 * has ever billed, across all sessions of all workspaces — the number the
 * drawer footer's 「总消耗 Token」 pill shows. The per-session sessionStats
 * projection only carries turn/step counts and wall times, and the turn
 * usage panel only knows the current conversation, so this module reads the
 * session corpus directly through the host's sessionQuery service (the same
 * service the community usage plugins fold).
 *
 * Accounting rule (mirrors the ecosystem's 「总花费 Token」 semantics):
 * for every `assistant/message` event whose data carries a projected usage,
 * add input + output + cache read + cache write + reasoning tokens. Stream
 * chunks are deliberately ignored — the projected `data.usage` is the
 * settled value the host already folded from the final stream chunk, and a
 * chunk-level fallback would double-count once both shapes coexist.
 *
 * The pure fold takes a structural `sessionQuery` slice (never a harness
 * import) so it unit-tests with synthetic sessions; unreadable sessions are
 * skipped and counted as failed, never failing the whole aggregate.
 */
/** Numeric guard: count only finite non-negative numbers, everything else is zero. */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
/** Yield to the event loop between session reads so a large corpus never starves the server. */
function yieldTurn() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
/**
 * Sessions folded between event-loop yields. Yielding every read is a
 * `setTimeout(0)` per session — on a corpus of thousands that alone costs
 * tens of milliseconds of scheduler churn. Batching keeps the server
 * responsive (each batch is a bounded chunk of work) without paying a timer
 * per record.
 */
const YIELD_EVERY = 8;
/** Fold one raw session snapshot into the running total. Returns true when a usable read landed. */
function foldSnapshot(snapshot, totals) {
    const events = snapshot?.events;
    if (!Array.isArray(events))
        return false;
    for (const event of events) {
        if (typeof event !== 'object' || event === null)
            continue;
        const record = event;
        if (record.type !== 'assistant/message')
            continue;
        if (typeof record.data !== 'object' || record.data === null)
            continue;
        const usage = record.data.usage;
        if (typeof usage !== 'object' || usage === null)
            continue;
        const fields = usage;
        totals.input += num(fields.inputTokens);
        totals.output += num(fields.outputTokens);
        totals.cacheRead += num(fields.cacheReadTokens);
        totals.cacheWrite += num(fields.cacheWriteTokens);
        totals.reasoning += num(fields.reasoningTokens);
    }
    return true;
}
/**
 * Aggregate lifetime token usage from the session corpus.
 * @param deps - Injected services; the fold never imports the harness.
 * @returns The settled total; unavailable corpus yields `ok: false`.
 */
export async function aggregateTokenUsage(deps) {
    if (deps.sessionQuery === undefined) {
        return { ok: false, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, sessions: 0, failed: 0 };
    }
    let records;
    try {
        records = await deps.sessionQuery.listSessions();
    }
    catch {
        return { ok: false, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, sessions: 0, failed: 0 };
    }
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    let sessions = 0;
    let failed = 0;
    let sinceYield = 0;
    for (const record of records) {
        if (typeof record !== 'object' || record === null) {
            failed += 1;
            continue;
        }
        const header = record.header ?? record;
        const id = header.id;
        if (typeof id !== 'string' || id === '') {
            failed += 1;
            continue;
        }
        try {
            const snapshot = await deps.sessionQuery.readSession(id);
            if (foldSnapshot(snapshot, totals))
                sessions += 1;
        }
        catch {
            failed += 1;
        }
        if (++sinceYield >= YIELD_EVERY) {
            sinceYield = 0;
            await yieldTurn();
        }
    }
    const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning;
    return {
        ok: true,
        totalTokens,
        inputTokens: totals.input,
        outputTokens: totals.output,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        reasoningTokens: totals.reasoning,
        sessions,
        failed,
    };
}
//# sourceMappingURL=token-usage.js.map