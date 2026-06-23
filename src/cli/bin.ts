#!/usr/bin/env node
// Dedicated executable entry. It runs `runCli` UNCONDITIONALLY — no `import.meta.url ===
// process.argv[1]` main-module guard. That guard (in 0.1.0/0.2.0's cli/index.ts) compared the
// resolved module path against argv[1], which is the *symlink* a global/npx install creates in
// bin/ — so the installed `track` silently did nothing. A separate entry that just runs is the
// same posture as track-mcp's cli.ts and cannot regress that way. `index.ts` stays import-only.
import { runCli } from './index.js'

// `runCli` returns `number | Promise<number>` — the `focus` command is async (it dynamically imports the
// optional `@sentropic/focus`); every other command stays sync and returns a plain number. `Promise.resolve`
// normalizes both into one exit path, so a sync command still exits with no added microtask churn beyond a
// resolved-promise tick.
Promise.resolve(
  runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }),
).then((rc) => process.exit(rc))
