import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerValue, isDeferrable, varyWithAcceptEncoding } from '../src/compress.ts'

test('headerValue finds keys regardless of casing', () => {
  assert.equal(headerValue({ 'Content-Type': 'application/json' }, 'content-type'), 'application/json')
  assert.equal(headerValue({ 'content-type': 'text/html' }, 'content-type'), 'text/html')
  assert.equal(headerValue({ 'CONTENT-ENCODING': 'gzip' }, 'content-encoding'), 'gzip')
  assert.equal(headerValue({ 'x-foo': '1' }, 'content-type'), undefined)
  assert.equal(headerValue({}, 'vary'), undefined)
  // Mixed-case keys are the raw writeHead argument reality.
  assert.equal(headerValue({ 'Content-Length': 123 }, 'content-length'), '123')
})

test('isDeferrable honors case-insensitive content-encoding / content-type', () => {
  // Lowercase keys (the pre-fix working case).
  assert.equal(isDeferrable({ 'content-type': 'application/json' }), true)
  assert.equal(isDeferrable({ 'content-type': 'application/json', 'content-encoding': 'gzip' }), false)
  assert.equal(isDeferrable({ 'content-type': 'text/html' }), false)
  // Mixed-case keys silently missed by the pre-fix direct lookup.
  assert.equal(isDeferrable({ 'Content-Type': 'application/json' }), true)
  assert.equal(isDeferrable({ 'Content-Type': 'application/json', 'Content-Encoding': 'br' }), false)
})

test('varyWithAcceptEncoding appends without clobbering, preserving key casing', () => {
  const none = {}
  varyWithAcceptEncoding(none)
  assert.deepEqual(none, { vary: 'Accept-Encoding' })

  const lowercase = { vary: 'Origin' }
  varyWithAcceptEncoding(lowercase)
  assert.equal(lowercase.vary, 'Origin, Accept-Encoding')

  const mixed = { Vary: 'Origin' }
  varyWithAcceptEncoding(mixed)
  assert.equal(mixed.Vary, 'Origin, Accept-Encoding')
  assert.equal(mixed.vary, undefined)
})
