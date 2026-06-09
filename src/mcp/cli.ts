#!/usr/bin/env node
// `track-mcp` bin — a stdio read-only MCP server over the nearest-ancestor `.track/events.jsonl`.
import { join } from 'node:path'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { resolveTrackDir } from '../cli/resolve.js'
import { createTrackMcpServer } from './server.js'

// P0 — SAME resolver as the CLI: nearest-ancestor `.track`, with `--track-dir <path>` / `TRACK_DIR`
// overrides. `track-mcp` is read-only and NEVER creates a store; if none resolves it fails STARTUP
// loud (rc=1 + stderr) rather than silently serving an empty/auto-created sidecar a writer never sees.
let eventsPath: string
try {
  const flagIdx = process.argv.indexOf('--track-dir')
  const flag = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined
  const env = process.env['TRACK_DIR']
  const trackDir = resolveTrackDir({
    cwd: process.cwd(),
    ...(flag !== undefined ? { flag } : {}),
    ...(env !== undefined ? { env } : {}),
  })
  eventsPath = join(trackDir, 'events.jsonl')
} catch (error) {
  process.stderr.write(
    `track-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}

const server = createTrackMcpServer(eventsPath)

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`track-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
