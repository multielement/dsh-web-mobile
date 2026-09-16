// Documentation consistency guard for the knowledge layer.
//
// Keeps three drift classes out of the tree:
// 1. AGENTS.md must reference only tracked assets that actually exist
//    (dead-reference class — the original multi-maintainer audit P0-1).
// 2. AGENTS.md must stay within the session-instruction budget (65536
//    bytes); narrative overflow belongs in docs/maintenance/pitfalls.md.
// 3. The machine-readable contract layer (docs/upstream/compat-contracts.json)
//    and the pitfalls archive (docs/maintenance/pitfalls.md) must stay
//    parseable and non-empty, because the condensed AGENTS.md entries point
//    into them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const readRepoFile = (relPath: string) => readFile(join(root, relPath), 'utf8')

const SESSION_INSTRUCTION_BUDGET_BYTES = 65_536

const REFERENCED_PATH_PATTERN =
  /(scripts\/probes\/[\w.-]+\.mjs|scripts\/cdp-[\w-]+\.mjs|docs\/specs\/[\w-]+\.md|docs\/audits\/[\w-]+\.md|docs\/upstream\/[\w-]+\.(?:md|json)|docs\/maintenance\/[\w-]+\.md)/g

test('AGENTS.md references only tracked assets that exist', async () => {
  const agents = await readRepoFile('AGENTS.md')
  const referenced = new Set(agents.match(REFERENCED_PATH_PATTERN) ?? [])
  assert.ok(
    referenced.size >= 10,
    `expected a healthy reference graph, found only ${referenced.size} references`,
  )
  for (const relPath of referenced) {
    await stat(join(root, relPath))
  }
})

test('AGENTS.md stays within the session instruction budget', async () => {
  const { size } = await stat(join(root, 'AGENTS.md'))
  assert.ok(
    size <= SESSION_INSTRUCTION_BUDGET_BYTES,
    `AGENTS.md is ${size} bytes (budget ${SESSION_INSTRUCTION_BUDGET_BYTES}) — move narrative into docs/maintenance/pitfalls.md`,
  )
})

test('compat-contracts.json entries are well-formed', async () => {
  const parsed = JSON.parse(await readRepoFile('docs/upstream/compat-contracts.json'))
  assert.ok(Array.isArray(parsed.contracts), 'contracts must be an array')
  assert.ok(parsed.contracts.length >= 20, 'expected the full runbook §2 contract set')
  for (const contract of parsed.contracts) {
    assert.ok(contract.id, 'contract missing id')
    assert.ok(contract.needle, `contract ${contract.id} missing needle`)
    assert.ok(
      contract.kind === 'hash' || contract.kind === 'marker',
      `contract ${contract.id} has unknown kind ${contract.kind}`,
    )
  }
})

test('pitfalls archive mirrors the condensed AGENTS.md pointers', async () => {
  const agents = await readRepoFile('AGENTS.md')
  const archive = await readRepoFile('docs/maintenance/pitfalls.md')
  const pointers = (agents.match(/docs\/maintenance\/pitfalls\.md` §/g) ?? []).length
  const sections = (archive.match(/^## /gm) ?? []).length
  assert.ok(sections >= 15, `archive has only ${sections} sections`)
  assert.ok(pointers >= 15, `AGENTS.md has only ${pointers} archive pointers`)
})
