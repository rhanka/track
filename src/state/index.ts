// State: fold(events) -> materialized state, rebuildable snapshots (SPEC §2, §3, §4).
export { fold, openBlockers, openBlockersForItem, type State } from './fold.js'
export {
  deserializeState,
  loadLatestSnapshot,
  saveSnapshot,
  serializeState,
  type SerializedState,
  type Snapshot,
} from './snapshot.js'
