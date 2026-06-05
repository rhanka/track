#!/usr/bin/env node
// `track-mcp` bin — a stdio read-only MCP server over the current dir's `.track/events.jsonl`.
import { join } from 'node:path'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createTrackMcpServer } from './server.js'

const eventsPath = join(process.cwd(), '.track', 'events.jsonl')
const server = createTrackMcpServer(eventsPath)

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`track-mcp failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
