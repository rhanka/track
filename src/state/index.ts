// State: fold(events) -> materialized state, rebuildable snapshots (SPEC §3, §4).
export { fold, type AggregateProjection, type State } from './fold.js'
export {
  deserializeState,
  loadLatestSnapshot,
  saveSnapshot,
  serializeState,
  type SerializedState,
  type Snapshot,
} from './snapshot.js'
