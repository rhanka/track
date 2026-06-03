import { describe, expect, it } from 'vitest'

import { canonicalize, computeHash, materialize } from './canonical.js'

describe('canonicalize', () => {
  it('sorts keys; absent equals explicit undefined', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalize({ x: undefined, a: 1 })).toBe(canonicalize({ a: 1 }))
  })

  it('keeps null distinct from absent', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}')
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}))
  })

  it('recurses into nested arrays and objects', () => {
    expect(canonicalize({ a: [3, { y: 1, x: 2 }] })).toBe('{"a":[3,{"x":2,"y":1}]}')
  })

  it('hashes UTF-8 / non-ASCII deterministically', () => {
    expect(computeHash({ s: 'éà — 漢字' })).toBe(computeHash({ s: 'éà — 漢字' }))
    expect(computeHash({ s: 'a' })).not.toBe(computeHash({ s: 'b' }))
  })

  it('pins -0 to "0" (JSON.stringify semantics, frozen)', () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}')
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/non-finite/)
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
  })

  it('rejects non-plain objects that would persist differently than they hash', () => {
    expect(() => canonicalize({ d: new Date(0) })).toThrow(/non-plain/)
    expect(() => canonicalize({ m: new Map() })).toThrow(/non-plain/)
    class Foo {
      x = 1
    }
    expect(() => canonicalize({ f: new Foo() })).toThrow(/non-plain/)
  })

  it('covers a JSON-reachable __proto__ own key in the hash (no A4 bypass)', () => {
    const a = JSON.parse('{"title":"x","__proto__":{"evil":1}}') as Record<string, unknown>
    const b = JSON.parse('{"title":"x","__proto__":{"evil":999}}') as Record<string, unknown>
    expect(canonicalize(a)).toContain('__proto__')
    expect(computeHash(a)).not.toBe(computeHash(b))
  })

  it('rejects an object carrying a toJSON method (hash/persist divergence)', () => {
    expect(() => canonicalize({ at: { toJSON: () => 'x' } })).toThrow(/toJSON/)
  })

  it('rejects a sparse array (hole would hash as [,1] but persist as [null,1])', () => {
    const sparse: unknown[] = []
    sparse[1] = 1 // index 0 is a hole
    expect(() => canonicalize({ a: sparse })).toThrow(/sparse/)
  })

  it('rejects an accessor (getter) property', () => {
    const o: Record<string, unknown> = {}
    Object.defineProperty(o, 'x', { get: () => 1, enumerable: true })
    expect(() => canonicalize(o)).toThrow(/accessor/)
  })

  it('materialize rejects an array carrying a toJSON method', () => {
    const a: number[] & { toJSON?: () => unknown } = [1]
    a.toJSON = () => [2]
    expect(() => materialize({ a })).toThrow(/toJSON/)
  })

  it('materialize rejects an accessor array index', () => {
    const a: unknown[] = []
    Object.defineProperty(a, 0, { get: () => 1, enumerable: true, configurable: true })
    expect(() => materialize({ a })).toThrow(/accessor/)
  })

  it('ignores an inherited (prototype) toJSON — immune to Object.prototype pollution', () => {
    const proto = Object.prototype as { toJSON?: unknown }
    proto.toJSON = () => 'polluted'
    try {
      expect(canonicalize({ a: 1 })).toBe('{"a":1}')
      expect(canonicalize(materialize({ a: 1 }))).toBe('{"a":1}')
    } finally {
      delete proto.toJSON
    }
  })

  it('rejects an array hole even when the prototype provides the index', () => {
    const arrayProto = Array.prototype as unknown as Record<number, unknown>
    arrayProto[0] = 'inherited'
    try {
      const a: unknown[] = []
      a.length = 1
      expect(() => materialize({ a })).toThrow(/sparse/)
      expect(() => canonicalize({ a })).toThrow(/sparse/)
    } finally {
      delete arrayProto[0]
    }
  })

  it('accepts a null-prototype object as plain', () => {
    const o = Object.create(null) as Record<string, unknown>
    o['a'] = 1
    expect(canonicalize(o)).toBe('{"a":1}')
  })

  it('computeHash is sha256-prefixed hex', () => {
    expect(computeHash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
