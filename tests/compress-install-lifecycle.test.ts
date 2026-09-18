import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { installResponseCompression } from '../src/compress.ts'

/**
 * The compression patch mutates `http.ServerResponse.prototype` process-wide,
 * so its install/dispose lifecycle must be idempotent and order-safe. These
 * tests pin the contract that a double install cannot double-wrap and that
 * an out-of-order dispose cannot strand the patch on the prototype.
 */

const proto = http.ServerResponse.prototype

/** Snapshot and restore the prototype around each test. */
function withPristineProto(fn: () => void): void {
  const saved = { writeHead: proto.writeHead, write: proto.write, end: proto.end }
  try {
    fn()
  } finally {
    proto.writeHead = saved.writeHead
    proto.write = saved.write
    proto.end = saved.end
  }
}

test('a double install does not wrap the wrapper', () => {
  withPristineProto(() => {
    const pristine = proto.writeHead
    const d1 = installResponseCompression()
    const afterFirst = proto.writeHead
    const d2 = installResponseCompression()
    const afterSecond = proto.writeHead

    assert.notEqual(afterFirst, pristine, 'first install patches the prototype')
    assert.equal(afterSecond, afterFirst, 'second install is a no-op (same function)')

    d2()
    assert.equal(proto.writeHead, afterFirst, 'the no-op disposer leaves the live patch in place')
    d1()
    assert.equal(proto.writeHead, pristine, 'the live disposer restores the pristine method')
  })
})

test('an out-of-order dispose still fully restores the prototype', () => {
  withPristineProto(() => {
    const pristineWriteHead = proto.writeHead
    const pristineWrite = proto.write
    const pristineEnd = proto.end

    const d1 = installResponseCompression()
    const d2 = installResponseCompression() // no-op

    // Reverse order: the no-op disposer first, then the real one.
    d2()
    d1()

    assert.equal(proto.writeHead, pristineWriteHead)
    assert.equal(proto.write, pristineWrite)
    assert.equal(proto.end, pristineEnd)
  })
})

test('reinstall after a full dispose works again', () => {
  withPristineProto(() => {
    const pristine = proto.writeHead
    const d1 = installResponseCompression()
    d1()
    assert.equal(proto.writeHead, pristine)

    const d2 = installResponseCompression()
    assert.notEqual(proto.writeHead, pristine, 'a fresh install patches again')
    d2()
    assert.equal(proto.writeHead, pristine)
  })
})

test('the live disposer is idempotent', () => {
  withPristineProto(() => {
    const pristine = proto.writeHead
    const d = installResponseCompression()
    d()
    d()
    assert.equal(proto.writeHead, pristine)
    // After the live disposer ran, a new install must be possible again.
    const d2 = installResponseCompression()
    assert.notEqual(proto.writeHead, pristine)
    d2()
    assert.equal(proto.writeHead, pristine)
  })
})