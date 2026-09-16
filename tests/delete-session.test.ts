import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSession, type DeleteSessionDeps } from '../src/delete-session.ts'

// Layout conventions mirrored from the JSONL backend (format.ts):
//   sessionDir(root, cwd, id) = <root>/<projectKey(cwd)>/<encodeSegment(id)>/
// projectKey('/home/u/proj') = '--home-u-proj--'
// encodeSegment('a/b')       = 'a~002Fb'
const SESSION_ID = 'sess-123'
const CWD = '/home/u/proj'
const PROJECT_DIR = '--home-u-proj--'

function storedHeader(id = SESSION_ID, cwd = CWD): { id: string; cwd?: string } {
  return { id, cwd }
}

async function scaffoldSession(root: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'v2.jsonl.zstd'), 'header\n')
}

test('removes the stored session directory and reports ok', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader() }],
      },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 200)
    assert.equal('deleted' in result && result.deleted, SESSION_ID)
    await assert.rejects(stat(dir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('escapes unsafe cwd and id segments while computing the directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const cwd = 'C:\\dev\\x'
    const id = 'a/b'
    const dir = join(root, '--C-dev-x--', 'a~002Fb')
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader(id, cwd) }],
      },
    }
    const result = await deleteSession(deps, id)
    assert.equal(result.status, 200)
    await assert.rejects(stat(dir), { code: 'ENOENT' })
    // The parent project directory survives; only the session directory is removed.
    await assert.doesNotReject(stat(join(root, '--C-dev-x--')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports 404 when the session is unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader('other-session') }],
      },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 404)
    assert.equal('error' in result && result.error.code, 'session-not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports 503 when the persistence backend exposes no root', async () => {
  const deps: DeleteSessionDeps = {
    persistence: {
      config: {},
      list: async () => [{ header: storedHeader() }],
    },
  }
  const result = await deleteSession(deps, SESSION_ID)
  assert.equal(result.status, 503)
  assert.equal('error' in result && result.error.code, 'persistence-unavailable')
})

test('stops a live agent, flushes, unregisters, then removes the directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const calls: string[] = []
    const live = { id: SESSION_ID }
    const agentEntry = { id: SESSION_ID }
    const agents = {
      get: () => ({
        cancel: (cause: unknown): void => {
          calls.push('cancel')
          assert.deepEqual(cause, { kind: 'disposed' })
        },
        whenIdle: async (): Promise<void> => { calls.push('whenIdle') },
      }),
      store: new Map([[SESSION_ID, agentEntry]]),
      detachEntered: (entry: unknown): void => {
        calls.push('detachEntered')
        assert.equal(entry, agentEntry)
      },
    }
    const sessionEntry = { detach: (): void => { calls.push('detach') } }
    const sessions = {
      get: () => live,
      flush: async (session: unknown): Promise<boolean> => {
        calls.push('flush')
        assert.equal(session, live)
        return true
      },
      store: new Map([[SESSION_ID, sessionEntry]]),
    }
    const detached: string[] = []
    const workspaceRegistry = {
      list: () => [
        { detachSession: async (id: string): Promise<void> => { detached.push(id) } },
        { detachSession: async (id: string): Promise<void> => { detached.push(id) } },
      ],
    }
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader() }],
      },
      sessions,
      agents,
      workspaceRegistry,
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 200)
    assert.deepEqual(calls, ['cancel', 'whenIdle', 'flush', 'detachEntered', 'detach'])
    assert.deepEqual(detached, [SESSION_ID, SESSION_ID])
    await assert.rejects(stat(dir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports 409 when the live agent does not converge to idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader() }],
      },
      sessions: {
        get: () => ({ id: SESSION_ID }),
        flush: async () => true,
      },
      agents: {
        get: () => ({
          cancel: (): void => {},
          whenIdle: async (): Promise<void> => { throw new Error('agent stuck') },
        }),
      },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 409)
    assert.equal('error' in result && result.error.code, 'session-busy')
    // Nothing was removed while the session could not be stopped.
    await assert.doesNotReject(stat(dir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports 500 when the artifact cannot be removed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    // A regular file where the session storage root is expected: rm resolves
    // the session directory to a nested path under a file and fails with
    // ENOTDIR.
    const root = join(base, 'not-a-dir')
    await writeFile(root, 'not a directory')
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        list: async () => [{ header: storedHeader() }],
      },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 500)
    assert.equal('error' in result && result.error.code, 'delete-failed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── mainline baselines（0.1.1-rc.2 / 0.1.2-rc.1 适配，非 fork 行为）──

test('accepts the flat SessionHeader[] list shape (0.1.1/0.1.2 hosts)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: {
        config: { root },
        // 0.1.2 及更早：list() 返回扁平 SessionHeader[]（无 .header 包裹）
        list: async () => [{ id: SESSION_ID, cwd: CWD }],
      },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 200)
    await assert.rejects(stat(dir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a live session whose agent face lacks the disposal API with 409', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: { config: { root }, list: async () => [{ header: storedHeader() }] },
      sessions: { get: () => ({ id: SESSION_ID }), flush: async () => true },
      // 0.1.1/0.1.2 的 agents.get() 返回不带 cancel/whenIdle 的 Agent face
      agents: { get: () => ({ id: SESSION_ID }) },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 409)
    assert.equal('error' in result && result.error.code, 'session-busy')
    // 目录必须原封未动：拒删不能附带破坏。
    await assert.doesNotReject(stat(dir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skips workspaces that expose no detachSession (0.1.1/0.1.2 hosts)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-'))
  try {
    const dir = join(root, PROJECT_DIR, SESSION_ID)
    await scaffoldSession(root, dir)
    const deps: DeleteSessionDeps = {
      persistence: { config: { root }, list: async () => [{ header: storedHeader() }] },
      workspaceRegistry: { list: () => [{}, { detachSession: async (): Promise<void> => {} }] },
    }
    const result = await deleteSession(deps, SESSION_ID)
    assert.equal(result.status, 200)
    await assert.rejects(stat(dir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
