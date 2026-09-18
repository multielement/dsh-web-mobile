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
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Structural sessionQuery slice this fold needs (the host service is never imported). */
export interface TokenUsageQuery {
  /** List every persisted session in the corpus (generation-agnostic entries). */
  listSessions(): Promise<unknown[]>
  /** Read one complete session log snapshot (live-preferred). */
  readSession(sessionId: string): Promise<unknown>
}

/** Dependencies of the aggregate fold; injected per request. */
export interface TokenUsageDeps {
  sessionQuery?: TokenUsageQuery
}

/** One settled aggregate, with the per-bucket breakdown preserved. */
export interface TokenUsageResult {
  ok: boolean
  /** Sum of input + output + cache read/write + reasoning tokens across all sessions. */
  totalTokens: number
  /** Prompt tokens billed without a cache read. */
  inputTokens: number
  /** Tokens the model generated. */
  outputTokens: number
  /** Prompt tokens served from the prompt cache. */
  cacheReadTokens: number
  /** Prompt tokens written into the prompt cache. */
  cacheWriteTokens: number
  /** Reasoning / thinking tokens. */
  reasoningTokens: number
  /** Sessions that contributed at least one usable read. */
  sessions: number
  /** Sessions whose log could not be read (skipped, not fatal). */
  failed: number
}

/** Yield to the event loop between session reads so a large corpus never starves the server. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Sessions folded between event-loop yields. Yielding every read is a
 * `setTimeout(0)` per session — on a corpus of thousands that alone costs
 * tens of milliseconds of scheduler churn. Batching keeps the server
 * responsive (each batch is a bounded chunk of work) without paying a timer
 * per record.
 */
const YIELD_EVERY = 8

/** Running per-bucket accumulator shared by every folded session. */
interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/** Fold one raw session snapshot into the running total. Returns true when a usable read landed. */
function foldSnapshot(snapshot: unknown, totals: UsageTotals): boolean {
  const events = (snapshot as { events?: unknown })?.events
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: unknown }
    if (record.type !== 'assistant/message') continue
    if (typeof record.data !== 'object' || record.data === null) continue
    const usage = (record.data as { usage?: unknown }).usage
    if (typeof usage !== 'object' || usage === null) continue
    const fields = usage as Record<string, unknown>
    totals.input += num(fields.inputTokens)
    totals.output += num(fields.outputTokens)
    totals.cacheRead += num(fields.cacheReadTokens)
    totals.cacheWrite += num(fields.cacheWriteTokens)
    totals.reasoning += num(fields.reasoningTokens)
  }
  return true
}

/**
 * Aggregate lifetime token usage from the session corpus.
 * @param deps - Injected services; the fold never imports the harness.
 * @returns The settled total; unavailable corpus yields `ok: false`.
 */
export async function aggregateTokenUsage(deps: TokenUsageDeps): Promise<TokenUsageResult> {
  if (deps.sessionQuery === undefined) {
    return { ok: false, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, sessions: 0, failed: 0 }
  }

  let records: unknown[]
  try {
    records = await deps.sessionQuery.listSessions()
  } catch {
    return { ok: false, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, sessions: 0, failed: 0 }
  }

  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let sessions = 0
  let failed = 0
  let sinceYield = 0
  for (const record of records) {
    if (typeof record !== 'object' || record === null) {
      failed += 1
      continue
    }
    const header = (record as { header?: unknown }).header ?? record
    const id = (header as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') {
      failed += 1
      continue
    }
    try {
      const snapshot = await deps.sessionQuery.readSession(id)
      if (foldSnapshot(snapshot, totals)) sessions += 1
    } catch {
      failed += 1
    }
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await yieldTurn()
    }
  }
  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning
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
  }
}
