import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth: the package's own package.json. Hardcoding a constant here
// drifts (it shipped as 0.0.0 in 0.1.0/0.2.0); reading the manifest keeps `track --version`
// and the MCP serverInfo honest. dist/version.js and src/version.ts both sit one dir below it.
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION: string = readVersion()
