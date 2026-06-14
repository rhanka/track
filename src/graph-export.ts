import type { State } from './state/fold.js'
import { VERSION } from './version.js'

type FileType = 'code' | 'document' | 'paper' | 'image' | 'concept' | 'rationale'
type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export interface TrackGraphNode {
  id: string
  label: string
  file_type: FileType
  source_file: string
  node_type: string
  source_location?: string
  confidence?: Confidence
  [key: string]: unknown
}

export interface TrackGraphEdge {
  source: string
  target: string
  relation: string
  confidence: Confidence
  source_file: string
  from: string
  to: string
  relation_type: string
  source_location?: string
  [key: string]: unknown
}

export interface TrackGraphProvenance {
  source_owner: 'track'
  source_id: string
  observed_at: string
  source_hash: string
  adapter_version: string
}

export interface TrackGraphFragment {
  nodes: TrackGraphNode[]
  edges: TrackGraphEdge[]
  provenance: TrackGraphProvenance
  input_tokens: number
  output_tokens: number
}

export interface TrackGraphExportOptions {
  repoKey: string
  sourceId: string
  observedAt: string
  sourceHash: string
  adapterVersion?: string
  sourceFile?: string
}

const DEFAULT_SOURCE_FILE = '.track/events.jsonl'

function commitId(repoKey: string, sha: string): string {
  return `commit:${repoKey}@${sha}`
}

function addNode(nodes: TrackGraphNode[], seen: Set<string>, node: TrackGraphNode): void {
  if (seen.has(node.id)) return
  seen.add(node.id)
  nodes.push(node)
}

function edgeKey(source: string, target: string, relation: string): string {
  return `${source}\u0000${target}\u0000${relation}`
}

function addEdge(
  edges: TrackGraphEdge[],
  seen: Set<string>,
  sourceFile: string,
  source: string,
  target: string,
  relation: string,
  extra: Record<string, unknown> = {},
): void {
  const key = edgeKey(source, target, relation)
  if (seen.has(key)) return
  seen.add(key)
  edges.push({
    source,
    target,
    relation,
    confidence: 'EXTRACTED',
    source_file: sourceFile,
    from: source,
    to: target,
    relation_type: relation,
    ...extra,
  })
}

function itemNodeType(kind: string): string {
  return kind === 'feature' ? 'Feature' : 'Item'
}

export function graphExportFromState(state: State, options: TrackGraphExportOptions): TrackGraphFragment {
  const sourceFile = options.sourceFile ?? DEFAULT_SOURCE_FILE
  const nodes: TrackGraphNode[] = []
  const edges: TrackGraphEdge[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  for (const item of state.items.values()) {
    addNode(nodes, nodeIds, {
      id: item.id,
      label: item.title,
      file_type: 'concept',
      source_file: sourceFile,
      source_location: `item:${item.id}`,
      node_type: itemNodeType(item.kind),
      track_kind: item.kind,
      workspace: item.workspace,
      spec_status: item.specStatus,
      realization: item.realization,
      ...(item.role !== undefined ? { role: item.role } : {}),
      ...(item.parentId !== undefined ? { parent_id: item.parentId } : {}),
      ...(item.sourceKey !== undefined ? { source_key: item.sourceKey } : {}),
    })
  }

  for (const criterion of state.criteria.values()) {
    addNode(nodes, nodeIds, {
      id: criterion.id,
      label: criterion.statement,
      file_type: 'rationale',
      source_file: sourceFile,
      source_location: `criterion:${criterion.id}`,
      node_type: 'AcceptanceCriterion',
      item_id: criterion.itemId,
    })
  }

  for (const decision of state.decisions.values()) {
    addNode(nodes, nodeIds, {
      id: decision.id,
      label: decision.title,
      file_type: 'rationale',
      source_file: sourceFile,
      source_location: `decision:${decision.id}`,
      node_type: 'Decision',
      workspace: decision.workspace,
      decision_kind: decision.decisionKind,
      outcome: decision.outcome,
      realization: decision.realization,
    })
  }

  for (const blocker of state.blockers.values()) {
    addNode(nodes, nodeIds, {
      id: blocker.id,
      label: blocker.reason || blocker.kind,
      file_type: 'rationale',
      source_file: sourceFile,
      source_location: `blocker:${blocker.id}`,
      node_type: 'Blocker',
      blocker_kind: blocker.kind,
      target_id: blocker.targetId,
      open: blocker.open,
      ...(blocker.ref !== undefined ? { ref: blocker.ref } : {}),
      ...(blocker.resolutionRule !== undefined ? { resolution_rule: blocker.resolutionRule } : {}),
    })
  }

  for (const evidence of state.evidence.values()) {
    const run = evidence.latestRun
    if (run === undefined) continue
    addNode(nodes, nodeIds, {
      id: evidence.id,
      label: `${run.runner} ${run.result} ${run.commit}`,
      file_type: 'rationale',
      source_file: sourceFile,
      source_location: `evidence:${evidence.id}`,
      node_type: 'EvidenceRun',
      criterion_id: evidence.criterionId,
      evidence_kind: evidence.kind,
      locator: evidence.locator,
      commit: run.commit,
      env: run.env,
      runner: run.runner,
      result: run.result,
      at: run.at,
    })

    const commitNode = commitId(options.repoKey, run.commit)
    addNode(nodes, nodeIds, {
      id: commitNode,
      label: run.commit,
      file_type: 'code',
      source_file: `commit:${options.repoKey}`,
      node_type: 'Commit',
      repo_key: options.repoKey,
      sha: run.commit,
    })
  }

  for (const item of state.items.values()) {
    if (item.parentId !== undefined && nodeIds.has(item.parentId)) {
      addEdge(edges, edgeIds, sourceFile, item.id, item.parentId, 'IMPLEMENTS')
    }
  }

  for (const criterion of state.criteria.values()) {
    if (nodeIds.has(criterion.itemId)) {
      addEdge(edges, edgeIds, sourceFile, criterion.itemId, criterion.id, 'IMPLEMENTS')
    }
  }

  for (const evidence of state.evidence.values()) {
    const run = evidence.latestRun
    if (run === undefined) continue
    const criterion = state.criteria.get(evidence.criterionId)
    if (criterion === undefined) continue

    const target = commitId(options.repoKey, run.commit)
    addEdge(edges, edgeIds, sourceFile, criterion.id, target, 'EVIDENCED_BY', {
      evidence_id: evidence.id,
      runner: run.runner,
      result: run.result,
    })
    if (nodeIds.has(criterion.itemId)) {
      addEdge(edges, edgeIds, sourceFile, criterion.itemId, target, 'EVIDENCED_BY', {
        criterion_id: criterion.id,
        evidence_id: evidence.id,
        runner: run.runner,
        result: run.result,
      })
    }
    addEdge(edges, edgeIds, sourceFile, evidence.id, target, 'EVIDENCED_BY', {
      criterion_id: criterion.id,
      runner: run.runner,
      result: run.result,
    })
  }

  for (const decision of state.decisions.values()) {
    for (const targetId of decision.targets) {
      if (nodeIds.has(targetId)) {
        addEdge(edges, edgeIds, sourceFile, decision.id, targetId, 'DECIDES', {
          decision_kind: decision.decisionKind,
          outcome: decision.outcome,
        })
      }
    }
  }

  for (const blocker of state.blockers.values()) {
    if (nodeIds.has(blocker.targetId)) {
      addEdge(edges, edgeIds, sourceFile, blocker.id, blocker.targetId, 'BLOCKS', {
        blocker_kind: blocker.kind,
        open: blocker.open,
      })
    }
    if (blocker.ref !== undefined && nodeIds.has(blocker.ref) && nodeIds.has(blocker.targetId)) {
      addEdge(edges, edgeIds, sourceFile, blocker.ref, blocker.targetId, 'BLOCKS', {
        blocker_id: blocker.id,
        blocker_kind: blocker.kind,
        open: blocker.open,
      })
    }
  }

  return {
    nodes,
    edges,
    provenance: {
      source_owner: 'track',
      source_id: options.sourceId,
      observed_at: options.observedAt,
      source_hash: options.sourceHash,
      adapter_version: options.adapterVersion ?? VERSION,
    },
    input_tokens: 0,
    output_tokens: 0,
  }
}
