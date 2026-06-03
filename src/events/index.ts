// Event contract: append-only frame, contentHash, positional chain, atomic cmdId batch (SPEC §3).
// The frozen contract everything folds over.
export * from './types.js'
export { canonicalize, computeHash, materialize } from './canonical.js'
export { contentHashOf, stripFrame } from './frame.js'
export { headPath, readHead, writeHead, type Head } from './head.js'
export { EventStore } from './store.js'
export { validate, type IntegrityFinding, type IntegrityResult } from './validate.js'
