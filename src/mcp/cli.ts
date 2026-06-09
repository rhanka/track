#!/usr/bin/env node
// `track-mcp` bin — a stdio read-only MCP server over the nearest-ancestor `.track/events.jsonl`.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import type { ResolveOptions } from '../cli/resolve.js'
import { createTrackMcpServer } from './server.js'

// Launch/serve alignment: like h2a `mcp-serve`, `track-mcp` BOOTS UNCONDITIONALLY and advertises its
// read tools without requiring pre-existing project state. The store is resolved LAZILY per read call
// (`--track-dir`→`TRACK_DIR`→nearest-ancestor `.track`), so a `.track` created AFTER boot is picked up
// without a restart. When none resolves, reads serve an honest-empty view + an init hint — `track-mcp`
// is read-only and NEVER creates a store. A bad EXPLICIT override stays loud (surfaced as a read error).
const flagIdx = process.argv.indexOf('--track-dir')
const flag = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined
const env = process.env['TRACK_DIR']
const resolveOpts: ResolveOptions = {
  cwd: process.cwd(),
  ...(flag !== undefined ? { flag } : {}),
  ...(env !== undefined ? { env } : {}),
}

const server = createTrackMcpServer(resolveOpts)

// Keep the transport fatal: a real connect/transport failure must stay loud (rc=1 + stderr).
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`track-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
