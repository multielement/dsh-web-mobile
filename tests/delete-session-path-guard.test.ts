import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isInside } from '../src/delete-session.ts'

/**
 * `isInside` uses the platform-default `path`, so on Linux CI only the posix
 * branch is reachable. The cross-volume contract is pinned separately by
 * exercising the same guard shape against `path.win32`, whose `relative`
 * returns an ABSOLUTE path for two different drives — the exact input that
 * made the pre-fix guard treat a foreign volume as inside the root.
 */

/** The guarded predicate, parameterized by a path implementation. */
function isInsideWith(p: typeof path.posix, root: string, target: string): boolean {
  const rel = p.relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith('..' + p.sep)) return false
  return !p.isAbsolute(rel)
}

// ── the real export, posix semantics ──

test('isInside accepts a true child', () => {
  assert.equal(isInside('/root/a', '/root/a/b'), true)
})

test('isInside rejects the root itself', () => {
  assert.equal(isInside('/root/a', '/root/a'), false)
})

test('isInside rejects a parent-directory escape', () => {
  assert.equal(isInside('/root/a', '/root/b'), false)
  assert.equal(isInside('/root/a', '/etc/passwd'), false)
})

test('isInside accepts a dotted-but-legal child name', () => {
  // '..b' is a legal directory name, not an escape.
  assert.equal(isInside('/root/a', '/root/a/..b'), true)
})

// ── the cross-volume contract (win32 semantics) ──

test('win32: a cross-drive target is rejected (the fixed hole)', () => {
  // relative('D:\\a','C:\\b') === 'C:\\b' (absolute) — outside by definition.
  assert.equal(isInsideWith(path.win32, 'D:\\a', 'C:\\b'), false)
})

test('win32: same-drive children and escapes still classify correctly', () => {
  assert.equal(isInsideWith(path.win32, 'D:\\a', 'D:\\a\\b'), true)
  assert.equal(isInsideWith(path.win32, 'D:\\a', 'D:\\a'), false)
  assert.equal(isInsideWith(path.win32, 'D:\\a', 'D:\\x'), false)
  assert.equal(isInsideWith(path.win32, 'D:\\a', 'D:\\a\\..b'), true)
})

test('win32: the pre-fix shape would have accepted the cross-drive target', () => {
  // Documents the regression this guard exists for.
  const w = path.win32
  const rel = w.relative('D:\\a', 'C:\\b')
  const oldVerdict = rel !== '..' && !rel.startsWith('..' + w.sep) && rel !== ''
  assert.equal(oldVerdict, true)
  assert.equal(isInsideWith(w, 'D:\\a', 'C:\\b'), false)
})