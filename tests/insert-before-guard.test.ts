import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Minimal DOM faithful to the one rule under test: `insertBefore(node, ref)`
 * throws NotFoundError when `ref` is not a child of the parent (DOM
 * pre-insert validity), and `appendChild` never does. Enough to prove the
 * detached-sibling guard in settings-toolbar-reparent / stats-line.
 */
class FakeNode {
  children: FakeNode[] = []
  parentNode: FakeNode | null = null
  isConnected = true
  label = ''
  constructor(label: string) { this.label = label }
  appendChild(node: FakeNode): FakeNode {
    if (node.parentNode !== null) {
      const i = node.parentNode.children.indexOf(node)
      if (i !== -1) node.parentNode.children.splice(i, 1)
    }
    this.children.push(node)
    node.parentNode = this
    return node
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (ref !== null && ref.parentNode !== this) {
      const err = new Error('The node before which the new node is to be inserted is not a child of this node.')
      err.name = 'NotFoundError'
      throw err
    }
    if (node.parentNode !== null) {
      const i = node.parentNode.children.indexOf(node)
      if (i !== -1) node.parentNode.children.splice(i, 1)
    }
    const at = ref === null ? this.children.length : this.children.indexOf(ref)
    this.children.splice(at, 0, node)
    node.parentNode = this
    return node
  }
  remove(): void {
    if (this.parentNode !== null) {
      const i = this.parentNode.children.indexOf(this)
      if (i !== -1) this.parentNode.children.splice(i, 1)
      this.parentNode = null
    }
    this.isConnected = false
  }
}

/** The disposed-restore shape both modules use, with the guard applied. */
function restoreGuarded(parent: FakeNode, node: FakeNode, next: FakeNode | null): void {
  if (next !== null && next.parentNode !== parent) {
    parent.appendChild(node)
  } else {
    parent.insertBefore(node, next)
  }
}

/** The pre-fix shape, to prove the hazard is real. */
function restoreUnguarded(parent: FakeNode, node: FakeNode, next: FakeNode | null): void {
  parent.insertBefore(node, next)
}

test('unguarded restore throws NotFoundError when the reference sibling detached', () => {
  const parent = new FakeNode('nav')
  const a = new FakeNode('a')
  const moved = new FakeNode('moved')
  const stale = new FakeNode('stale')
  parent.appendChild(a)
  parent.appendChild(stale)
  // React rebuild: the recorded `next` (stale) is removed, parent stays.
  stale.remove()

  assert.throws(
    () => restoreUnguarded(parent, moved, stale),
    (err: Error) => err.name === 'NotFoundError',
  )
})

test('guarded restore appends instead of throwing on a detached sibling', () => {
  const parent = new FakeNode('nav')
  const moved = new FakeNode('moved')
  const stale = new FakeNode('stale')
  parent.appendChild(stale)
  stale.remove()

  assert.doesNotThrow(() => restoreGuarded(parent, moved, stale))
  assert.equal(moved.parentNode, parent)
  assert.ok(parent.children.includes(moved))
})

test('guarded restore keeps the exact position when the sibling is intact', () => {
  const parent = new FakeNode('nav')
  const first = new FakeNode('first')
  const moved = new FakeNode('moved')
  parent.appendChild(first)
  parent.appendChild(moved)

  restoreGuarded(parent, moved, first)
  assert.deepEqual(parent.children.map((n) => n.label), ['moved', 'first'])
})

test('guarded restore handles a null reference (append to end)', () => {
  const parent = new FakeNode('nav')
  const first = new FakeNode('first')
  const moved = new FakeNode('moved')
  parent.appendChild(first)

  restoreGuarded(parent, moved, null)
  assert.deepEqual(parent.children.map((n) => n.label), ['first', 'moved'])
})