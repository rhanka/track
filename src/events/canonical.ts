import { createHash } from 'node:crypto'

/**
 * Deterministic canonical JSON, plus `materialize`. Together they make the **hash domain equal
 * the persisted domain by construction** — the store hashes via `computeHash` and persists via
 * `canonicalize`, i.e. the SAME serialization function, applied to the SAME inert snapshot:
 *
 *  - `materialize(value)` performs ONE traversal of the (possibly live) input, returning an
 *    inert plain-data deep clone and fail-loud rejecting anything whose hash form would differ
 *    from its persisted form. A live value (a `Proxy`, a non-idempotent getter) is therefore
 *    frozen to what the single traversal read.
 *  - `canonicalize` and `materialize` inspect ONLY own properties (`Object.hasOwn`, own
 *    descriptors) and never honour an inherited `toJSON`/accessor/index — so a polluted
 *    `Object.prototype`/`Array.prototype` cannot make the two diverge.
 *
 * Rejected (fail-loud, before any write): non-finite numbers, non-plain objects (`Date`/`Map`/
 * class), own `toJSON`, accessor (getter/setter) properties, sparse-array holes (and inherited
 * indices), `undefined`/symbol/function members. Hardened relative to h2a's `canonical.ts`
 * (kept h2a-free per SPEC §9).
 */

function rejectExoticContainer(value: object): void {
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value) as object | null
    if (proto !== null && proto !== Object.prototype) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
      throw new Error(`canonicalize: non-plain object is not supported (${name})`)
    }
  }
  if (
    Object.hasOwn(value, 'toJSON') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    throw new Error('canonicalize: value with an own toJSON is not supported (hash/persist divergence)')
  }
}

function eachArrayIndex(value: unknown[], visit: (index: number) => void): void {
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) {
      throw new Error('canonicalize: sparse arrays (holes / inherited indices) are not supported')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, i)!
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`canonicalize: accessor array index ${i} is not supported`)
    }
    visit(i)
  }
}

/** One-pass deep clone to inert plain data, rejecting anything that would hash ≠ persist. */
export function materialize(value: unknown): unknown {
  if (value === null) return null

  if (Array.isArray(value)) {
    rejectExoticContainer(value)
    const out: unknown[] = []
    eachArrayIndex(value, (i) => {
      out.push(materialize(value[i]))
    })
    return out
  }

  const kind = typeof value

  if (kind === 'object') {
    rejectExoticContainer(value as object)
    const source = value as Record<string, unknown>
    // null-proto accumulator so a literal `__proto__` own key clones as a data key (no setter).
    const out = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error(`canonicalize: accessor property "${key}" is not supported`)
      }
      const child = source[key]
      if (child === undefined) continue
      out[key] = materialize(child)
    }
    return out
  }

  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite numbers are not supported (${value as number})`)
    }
    return value
  }

  if (kind === 'string' || kind === 'boolean') {
    return value
  }

  throw new Error(`canonicalize: unsupported value type (${kind})`)
}

/** Deterministic JSON string: sort keys, drop `undefined`, own-properties only. */
function canonicalString(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    rejectExoticContainer(value)
    const members: string[] = []
    eachArrayIndex(value, (i) => {
      members.push(canonicalString(value[i]))
    })
    return '[' + members.join(',') + ']'
  }

  const kind = typeof value

  if (kind === 'object') {
    rejectExoticContainer(value as object)
    const source = value as Record<string, unknown>
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error(`canonicalize: accessor property "${key}" is not supported`)
      }
    }
    const keys = Object.keys(source)
      .filter((key) => source[key] !== undefined)
      .sort()
    const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalString(source[key])}`)
    return '{' + members.join(',') + '}'
  }

  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite numbers are not supported (${value as number})`)
    }
    return JSON.stringify(value)
  }

  if (kind === 'string' || kind === 'boolean') {
    return JSON.stringify(value)
  }

  throw new Error(`canonicalize: unsupported value type (${kind})`)
}

export function canonicalize(value: unknown): string {
  return canonicalString(value)
}

export function computeHash(value: unknown): string {
  const canonical = canonicalize(value)
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `sha256:${digest}`
}
