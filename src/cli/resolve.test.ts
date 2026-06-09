import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveTrackDir, resolveTrackDirOrNull, TrackDirNotFoundError } from './resolve.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-resolve-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveTrackDir — nearest-ancestor .track resolution', () => {
  it('finds an existing .track in the cwd itself', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    expect(resolveTrackDir({ cwd: root })).toBe(join(root, '.track'))
  })

  it('walks upward to the NEAREST ancestor .track from a subdir', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    const sub = join(root, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    expect(resolveTrackDir({ cwd: sub })).toBe(join(root, '.track'))
  })

  it('prefers the closest .track when ancestors nest', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    const inner = join(root, 'inner')
    mkdirSync(join(inner, '.track'), { recursive: true })
    const sub = join(inner, 'deep')
    mkdirSync(sub, { recursive: true })
    expect(resolveTrackDir({ cwd: sub })).toBe(join(inner, '.track'))
  })

  it('throws TrackDirNotFoundError when no .track exists upward (does NOT create one)', () => {
    const sub = join(root, 'x', 'y')
    mkdirSync(sub, { recursive: true })
    expect(() => resolveTrackDir({ cwd: sub })).toThrow(TrackDirNotFoundError)
    expect(existsSync(join(sub, '.track'))).toBe(false)
    expect(existsSync(join(root, '.track'))).toBe(false)
  })

  it('honors an explicit --track-dir flag over ancestor resolution', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    const explicit = join(root, 'custom-track')
    mkdirSync(explicit, { recursive: true })
    expect(resolveTrackDir({ cwd: root, flag: explicit })).toBe(explicit)
  })

  it('honors the TRACK_DIR env override', () => {
    const explicit = join(root, 'env-track')
    mkdirSync(explicit, { recursive: true })
    expect(resolveTrackDir({ cwd: root, env: explicit })).toBe(explicit)
  })

  it('flag wins over env', () => {
    const flagDir = join(root, 'flag-track')
    const envDir = join(root, 'env-track')
    mkdirSync(flagDir, { recursive: true })
    mkdirSync(envDir, { recursive: true })
    expect(resolveTrackDir({ cwd: root, flag: flagDir, env: envDir })).toBe(flagDir)
  })

  it('an explicit override that does not exist still throws (only init creates)', () => {
    const missing = join(root, 'nope')
    expect(() => resolveTrackDir({ cwd: root, flag: missing })).toThrow(TrackDirNotFoundError)
    expect(existsSync(missing)).toBe(false)
  })
})

describe('resolveTrackDirOrNull — non-throwing read resolver (serve-empty)', () => {
  it('returns the nearest-ancestor .track when one exists', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    const sub = join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(resolveTrackDirOrNull({ cwd: sub })).toBe(join(root, '.track'))
  })

  it('returns null when no .track exists upward (does NOT create one)', () => {
    const sub = join(root, 'x', 'y')
    mkdirSync(sub, { recursive: true })
    expect(resolveTrackDirOrNull({ cwd: sub })).toBeNull()
    expect(existsSync(join(sub, '.track'))).toBe(false)
    expect(existsSync(join(root, '.track'))).toBe(false)
  })

  it('honors an explicit --track-dir / TRACK_DIR override when it exists', () => {
    const explicit = join(root, 'custom-track')
    mkdirSync(explicit, { recursive: true })
    expect(resolveTrackDirOrNull({ cwd: root, flag: explicit })).toBe(explicit)
    expect(resolveTrackDirOrNull({ cwd: root, env: explicit })).toBe(explicit)
  })

  it('STILL throws on a bad explicit override (explicit wrong path = user error, not null)', () => {
    const missing = join(root, 'nope')
    expect(() => resolveTrackDirOrNull({ cwd: root, flag: missing })).toThrow(TrackDirNotFoundError)
    expect(() => resolveTrackDirOrNull({ cwd: root, env: missing })).toThrow(TrackDirNotFoundError)
    expect(existsSync(missing)).toBe(false)
  })
})
