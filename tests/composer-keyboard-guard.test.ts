// Composer keyboard guard: the iOS fix that keeps a dismissed keyboard
// down when the composer's fixed buttons (send/stop/+) are tapped.
// Upstream keepFocus calls editor.focus() on mousedown, which iOS WebKit
// treats as a programmatic focus that re-raises the on-screen keyboard.
// The guard shadows HTMLElement.prototype.focus on the contenteditable for
// the duration of the tap's mousedown dispatch, then restores it.
//
// The DOM half (capture listener, closest() scoping) is browser-only; these
// tests audit the source invariants the fix depends on, mirroring how
// ios-zoom-guard.test.ts audits the CSS floor via stylesheet constants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/client/effects/composer-keyboard-guard.ts', import.meta.url)),
  'utf8',
)

test('guard is scoped to iOS WebKit via the shared detectIosWebKit probe', () => {
  assert.match(SOURCE, /detectIosWebKit\(/)
  // Android/desktop never install the listener at all.
  assert.match(SOURCE, /if \(!detectIosWebKit\([\s\S]*?\)\) \{/)
  assert.match(SOURCE, /return undefined/)
})

test('guard listens on mousedown in the capture phase', () => {
  assert.match(SOURCE, /addEventListener\('mousedown', onMouseDown, true\)/)
  assert.match(SOURCE, /removeEventListener\('mousedown', onMouseDown, true\)/)
})

test('guard scopes the shadow to composer-card taps outside the editor surface', () => {
  assert.match(SOURCE, /\[data-composer-card\]/)
  assert.match(SOURCE, /target\.closest\(COMPOSER_INPUT_SELECTOR\) !== null/)
  // The editor's own focus path (tap-to-type) must never be shadowed.
  assert.match(SOURCE, /if \(editor === null \|\|/)
})

test('shadow restores deterministically and never outlives the tap', () => {
  assert.match(SOURCE, /setTimeout\(restore, 0\)/)
  assert.match(SOURCE, /SHADOW_MARKER = 'data-mobile-nav-focus-shadow'/)
})

test('disposal restores any live shadow — reloads never leak the no-op', () => {
  // The disposer calls restore() unconditionally.
  assert.match(SOURCE, /document\.removeEventListener\('mousedown', onMouseDown, true\)\s*\n\s*restore\(\)/)
})

test('the effect is wired into the client entry', () => {
  const entry = readFileSync(
    fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(entry, /installComposerKeyboardGuard\(ctx\)/)
})
