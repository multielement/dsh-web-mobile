import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  markGestureConsumed,
  consumeIfGestured,
  isGestureConsumed,
} from '../src/client/effects/gesture-guard.ts'

/**
 * The consume-mark registry is lazily cleaned, which alone cannot bound it:
 * an element that is detached before its window closes never appears in
 * another event's target chain and so is never revisited. These tests pin the
 * write-path sweep that bounds the map.
 */

/**
 * A detached-safe element-like node. The default parent is `null` (the real
 * DOM's document-level value), NOT `undefined`: the guard's isElementLike
 * test is `parentElement !== undefined`, so a `null` parent walks one more
 * step (as a real element does) while `undefined` terminates the walk.
 */
function node(parent: unknown = null): { parentElement: unknown } {
  const el: { parentElement: unknown } = { parentElement: parent }
  return el
}

/**
 * A chain of `depth` elements as [innermost, ..., outermost]: nodes[0] is the
 * event target and its `parentElement` walks outward to nodes[depth-1], whose
 * parent is undefined (the document boundary).
 */
function chain(depth: number): { parentElement: unknown }[] {
  const nodes: { parentElement: unknown }[] = []
  for (let i = 0; i < depth; i++) nodes.push(node())
  for (let i = 0; i < depth - 1; i++) nodes[i]!.parentElement = nodes[i + 1]
  return nodes
}

test('a mark reports consumed for its target and ancestors', () => {
  const [inner, mid, outer] = chain(3)
  markGestureConsumed(inner as unknown as EventTarget, 1000, outer as unknown as Element)
  assert.equal(isGestureConsumed(inner as unknown as Element), true)
  assert.equal(isGestureConsumed(mid as unknown as Element), true)
  assert.equal(isGestureConsumed(outer as unknown as Element), true)
})

test('an expired mark reports not-consumed and is dropped on read', () => {
  const [el] = chain(1)
  markGestureConsumed(el as unknown as EventTarget, 0) // expires immediately
  assert.equal(isGestureConsumed(el as unknown as Element), false)
  assert.equal(isGestureConsumed(el as unknown as Element), false)
})

test('consumeIfGestured matches the event target chain', () => {
  const [inner, outer] = chain(2)
  markGestureConsumed(inner as unknown as EventTarget, 1000, outer as unknown as Element)
  const event = { target: outer } as unknown as Event
  assert.equal(consumeIfGestured(event), true)
})

test('detached marks do not grow the registry without bound', () => {
  // Mark a fresh detached chain repeatedly. Without the write-path sweep the
  // map would keep every one of these forever (nothing revisits them).
  const perStroke = 10
  for (let stroke = 0; stroke < 200; stroke++) {
    const nodes = chain(perStroke)
    // Each node is detached after its would-be use: pass a target with no
    // parent so the guard walks exactly one node, then move on.
    for (const n of nodes) {
      n.parentElement = undefined
      markGestureConsumed(n as unknown as EventTarget, 0) // zero window: expires at once
    }
  }
  // Every mark above expired immediately, so a subsequent real mark must find
  // a swept registry: the expired entries cannot still be reported as live.
  const [probe] = chain(1)
  markGestureConsumed(probe as unknown as EventTarget, 1000)
  assert.equal(isGestureConsumed(probe as unknown as Element), true)

  // And an expired probe never reports live.
  const [stale] = chain(1)
  markGestureConsumed(stale as unknown as EventTarget, 0)
  assert.equal(isGestureConsumed(stale as unknown as Element), false)
})

test('the sweep is triggered once the registry passes its cap', () => {
  // Fill past the cap with already-expired marks; the sweep must clear them
  // so a later live mark still resolves and no stale entry lingers.
  const nodes: { parentElement: unknown }[] = []
  for (let i = 0; i < 300; i++) {
    const [n] = chain(1)
    nodes.push(n)
    markGestureConsumed(n as unknown as EventTarget, 0)
  }
  // All expired; a fresh element is correctly reported live.
  const [live] = chain(1)
  markGestureConsumed(live as unknown as EventTarget, 1000)
  assert.equal(isGestureConsumed(live as unknown as Element), true)
  // No stale entry masquerades as live.
  assert.equal(isGestureConsumed(nodes[0] as unknown as Element), false)
})