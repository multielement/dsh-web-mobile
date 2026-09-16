import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MAX_REQUEST_BODY_BYTES,
  createDeleteHandler,
  createTokensHandler,
  readRequestBody,
  type DeleteSessionResult,
  type RouteDeps,
} from '../src/route-guard.ts'

/** Minimal IncomingMessage stand-in: EventEmitter + the stream fields the guard reads. */
class FakeRequest extends EventEmitter {
  headers: Record<string, string | string[] | undefined> = {}
  method = 'POST'
  bodyChunks: string[] = []
  aborted = false
  setEncoding(): void {
    // The guard asks for utf8; chunks below are already strings.
  }
}

/** Minimal ServerResponse stand-in capturing one JSON response. */
class FakeResponse extends EventEmitter {
  status = 0
  body: unknown = undefined
  writeHead(status: number): void {
    this.status = status
  }
  end(payload: string): void {
    this.body = JSON.parse(payload)
  }
}

interface HandlerRun {
  request: FakeRequest
  response: FakeResponse
  /** Wait for the async handler to settle. */
  settled: Promise<void>
}

/** Drive one request through a guarded handler with the given deps. */
function runHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  deps: RouteDeps,
  options: { method?: string, body?: string } = {},
): HandlerRun {
  const request = new FakeRequest()
  if (options.method !== undefined) request.method = options.method
  const response = new FakeResponse()
  const settled = handler(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  )
  if (options.body !== undefined) {
    request.emit('data', options.body)
  }
  request.emit('end')
  return { request, response, settled }
}

const DEFAULT_DEPS: RouteDeps = {
  resolve: () => undefined,
  rejection: () => undefined,
  deleteSession: async () => ({ ok: true, status: 200, deleted: 'sess-1' }),
  aggregateTokenUsage: async () => ({ ok: true, totalTokens: 42, sessions: 2, failed: 0 }),
}

// ---- auth gate: rejection wins over everything ----

test('delete: 401 auth rejection answers access-denied and skips the core', async () => {
  let coreCalls = 0
  const { response, settled } = runHandler(
    createDeleteHandler({
      ...DEFAULT_DEPS,
      rejection: () => 401,
      deleteSession: async () => {
        coreCalls++
        return { ok: true, status: 200, deleted: 'x' }
      },
    }),
    DEFAULT_DEPS,
    { body: '{}' },
  )
  await settled
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { error: { code: 'access-denied', message: '需要当前浏览器鉴权' } })
  assert.equal(coreCalls, 0)
})

test('delete: 403 auth rejection answers access-denied', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler({ ...DEFAULT_DEPS, rejection: () => 403 }),
    DEFAULT_DEPS,
    { body: '{}' },
  )
  await settled
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: { code: 'access-denied', message: '需要当前浏览器鉴权' } })
})

// ---- method gate ----

test('delete: non-POST answers 405 before reading the body', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { method: 'GET', body: 'garbage that is not even json' },
  )
  await settled
  assert.equal(response.status, 405)
  assert.deepEqual(response.body, { error: { code: 'method-not-allowed', message: 'POST required' } })
})

// ---- body gate ----

test('delete: invalid JSON answers 400 invalid-body', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { body: 'not json' },
  )
  await settled
  assert.equal(response.status, 400)
  assert.equal((response.body as { error: { code: string } }).error.code, 'invalid-body')
})

test('delete: array body answers 400 invalid-body', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { body: '["sess-1"]' },
  )
  await settled
  assert.equal(response.status, 400)
  assert.equal((response.body as { error: { code: string } }).error.code, 'invalid-body')
})

test('delete: oversized body answers 413 body-too-large', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { body: '{"pad":"' + 'x'.repeat(MAX_REQUEST_BODY_BYTES) + '"}' },
  )
  await settled
  assert.equal(response.status, 413)
  assert.deepEqual(response.body, {
    error: { code: 'body-too-large', message: 'request body exceeds the 4KB limit' },
  })
})

test('delete: aborted request answers 400 and never reaches the core', async () => {
  const request = new FakeRequest()
  const response = new FakeResponse()
  const settled = createDeleteHandler(DEFAULT_DEPS)(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  )
  request.emit('aborted')
  await settled
  assert.equal(response.status, 400)
})

test('delete: empty or non-string sessionId answers 400 invalid-session-id', async () => {
  const { response, settled } = runHandler(
    createDeleteHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { body: '{"sessionId":7}' },
  )
  await settled
  assert.equal(response.status, 400)
  assert.equal((response.body as { error: { code: string } }).error.code, 'invalid-session-id')
})

// ---- service gate ----

test('delete: missing persistence service answers 503 without calling the core', async () => {
  let coreCalls = 0
  const { response, settled } = runHandler(
    createDeleteHandler({
      ...DEFAULT_DEPS,
      resolve: () => undefined,
      deleteSession: async () => {
        coreCalls++
        return { ok: true, status: 200, deleted: 'x' }
      },
    }),
    DEFAULT_DEPS,
    { body: '{"sessionId":"sess-1"}' },
  )
  await settled
  assert.equal(response.status, 503)
  assert.deepEqual(response.body, {
    error: { code: 'persistence-unavailable', message: 'session persistence is not configured' },
  })
  assert.equal(coreCalls, 0)
})

// ---- happy path + error passthrough ----

test('delete: resolves services per request and passes them to the core', async () => {
  const persistence = { list: async () => [] }
  const sessions = { get: () => undefined }
  const seen: Record<string, unknown> = {}
  const { response, settled } = runHandler(
    createDeleteHandler({
      ...DEFAULT_DEPS,
      resolve: (name) => {
        const table: Record<string, unknown> = { sessionPersistence: persistence, sessions }
        return table[name]
      },
      deleteSession: async (deps, sessionId) => {
        Object.assign(seen, deps)
        assert.equal(sessionId, 'sess-1')
        return { ok: true, status: 200, deleted: 'sess-1' }
      },
    }),
    DEFAULT_DEPS,
    { body: '{"sessionId":"sess-1"}' },
  )
  await settled
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true, deleted: 'sess-1' })
  assert.equal(seen['persistence'], persistence)
  assert.equal(seen['sessions'], sessions)
})

test('delete: core failure passes status and error through, with a warn log', async () => {
  const failure: DeleteSessionResult = {
    ok: false,
    status: 404,
    error: { code: 'session-not-found', message: 'no such session' },
  }
  const warns: string[] = []
  const { response, settled } = runHandler(
    createDeleteHandler({
      ...DEFAULT_DEPS,
      resolve: (name) => (name === 'sessionPersistence' ? { list: async () => [] } : undefined),
      deleteSession: async () => failure,
      logger: { warn: (message) => warns.push(message) },
    }),
    DEFAULT_DEPS,
    { body: '{"sessionId":"gone"}' },
  )
  await settled
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: { code: 'session-not-found', message: 'no such session' } })
  assert.equal(warns.length, 1)
  assert.match(warns[0] as string, /session-delete failed for 'gone' \(session-not-found\)/)
})

// ---- token route ----

test('tokens: 401 auth rejection answers access-denied and skips the fold', async () => {
  const { response, settled } = runHandler(
    createTokensHandler({ ...DEFAULT_DEPS, rejection: () => 401 }),
    DEFAULT_DEPS,
    { method: 'GET', body: '' },
  )
  await settled
  assert.equal(response.status, 401)
  assert.equal((response.body as { error: { code: string } }).error.code, 'access-denied')
})

test('tokens: non-GET answers 405', async () => {
  const { response, settled } = runHandler(
    createTokensHandler(DEFAULT_DEPS),
    DEFAULT_DEPS,
    { method: 'POST', body: '' },
  )
  await settled
  assert.equal(response.status, 405)
  assert.deepEqual(response.body, { error: { code: 'method-not-allowed', message: 'GET required' } })
})

test('tokens: folds via the injected core and answers 200', async () => {
  const { response, settled } = runHandler(
    createTokensHandler({
      ...DEFAULT_DEPS,
      resolve: (name) => (name === 'sessionQuery' ? { listSessions: async () => [] } : undefined),
      aggregateTokenUsage: async () => ({ ok: true, totalTokens: 42, sessions: 2, failed: 0 }),
    }),
    DEFAULT_DEPS,
    { method: 'GET', body: '' },
  )
  await settled
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true, totalTokens: 42, sessions: 2, failed: 0 })
})

test('tokens: ok:false fold answers 503', async () => {
  const { response, settled } = runHandler(
    createTokensHandler({
      ...DEFAULT_DEPS,
      resolve: (name) => (name === 'sessionQuery' ? { listSessions: async () => [] } : undefined),
      aggregateTokenUsage: async () => ({ ok: false, totalTokens: 0, sessions: 0, failed: 0 }),
    }),
    DEFAULT_DEPS,
    { method: 'GET', body: '' },
  )
  await settled
  assert.equal(response.status, 503)
  assert.equal((response.body as { error: { code: string } }).error.code, 'session-query-unavailable')
})

test('tokens: missing sessionQuery service answers 503 without calling the fold', async () => {
  let foldCalls = 0
  const { response, settled } = runHandler(
    createTokensHandler({
      ...DEFAULT_DEPS,
      resolve: () => undefined,
      aggregateTokenUsage: async () => {
        foldCalls++
        return { ok: true, totalTokens: 0, sessions: 0, failed: 0 }
      },
    }),
    DEFAULT_DEPS,
    { method: 'GET', body: '' },
  )
  await settled
  assert.equal(response.status, 503)
  assert.equal(foldCalls, 0)
})

// ---- readRequestBody settle semantics ----

test('readRequestBody: accepts a body at exactly the cap', async () => {
  const request = new FakeRequest()
  const settled = readRequestBody(request)
  request.emit('data', 'x'.repeat(MAX_REQUEST_BODY_BYTES))
  request.emit('end')
  assert.equal((await settled).length, MAX_REQUEST_BODY_BYTES)
})

test('readRequestBody: settles once and ignores events after end', async () => {
  const request = new FakeRequest()
  const settled = readRequestBody(request)
  request.emit('data', 'ok')
  request.emit('end')
  request.emit('data', 'late')
  request.emit('error', new Error('must be ignored'))
  assert.equal(await settled, 'ok')
})
