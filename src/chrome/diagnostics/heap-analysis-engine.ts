import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { z } from "zod/v4";
import type {
  HeapAnalysisRequest,
  HeapAnalysisResult,
  HeapClassDelta,
  HeapClassSummary,
  HeapDiff,
  HeapDominator,
  HeapNodeSummary,
  HeapQueryRequest,
  HeapQueryResult,
  HeapRetainingPath,
  HeapRetainingPathStep,
  HeapSnapshotStats,
  HeapSummary,
  HeapTypeSummary,
} from "./heap-analysis-protocol";
import { isRecord } from "../../platform/records";
import { loadHeapFrontend } from "./frontend-adapter";
import { heapContextAttributionSchema } from "./heap-analysis-protocol";

const MAX_OUTPUT_STRING_LENGTH = 160;

type HeapSnapshotLayout = {
  edgeNameOffset: number;
  edgeSize: number;
  edgeToNodeOffset: number;
  edgeTypeNames: string[];
  edgeTypeOffset: number;
  nodeEdgeCountOffset: number;
  nodeIdOffset: number;
  nodeNameOffset: number;
  nodeSelfSizeOffset: number;
  nodeSize: number;
  nodeTypeNames: string[];
  nodeTypeOffset: number;
};

type ParsedHeapSnapshot = {
  edgeCount: number;
  edgeStarts: Uint32Array;
  edges: number[];
  layout: HeapSnapshotLayout;
  nodeCount: number;
  nodes: number[];
  strings: string[];
};

type ClassAggregate = {
  count: number;
  name: string;
  shallowSize: number;
  type: string;
};

type SnapshotAggregates = {
  byClass: Map<string, ClassAggregate>;
  stats: HeapSnapshotStats;
  summary: HeapSummary;
};

type DominatorAnalysis = {
  dominators: { dfsIndex: number; result: HeapDominator }[];
  parent: Uint32Array;
  parentEdge: Uint32Array;
  vertex: Uint32Array;
  dfsNumber: Uint32Array;
  retainedSizes: Float64Array;
};

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const formatError = (message: string): Error => new Error(`Invalid V8 heap snapshot: ${message}`);

const itemAt = <T>(values: ArrayLike<T>, index: number, name: string): T => {
  const value = values[index];
  if (value === undefined) throw formatError(`${name} is missing`);

  return value;
};

const numberAt = itemAt<number>;

const requireInteger = (value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw formatError(`${name} is invalid`);
  return value;
};

const requireFieldOffset = (fields: string[], field: string, name: string): number => {
  const offset = fields.indexOf(field);
  if (offset < 0) throw formatError(`${name} is missing ${field}`);
  return offset;
};

const requireStringTypes = (types: unknown[], offset: number, name: string): string[] => {
  const values = types[offset];
  if (!isStringArray(values) || values.length === 0) throw formatError(`${name} types are invalid`);
  return values;
};

const compactString = (value: string, fallback: string): string => {
  const normalized = value.length === 0 ? fallback : value;
  if (normalized.length <= MAX_OUTPUT_STRING_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_OUTPUT_STRING_LENGTH - 1)}…`;
};

const parseSnapshot = (source: string) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw formatError("the artifact could not be read as JSON");
  }
  if (!isRecord(decoded) || !isRecord(decoded.snapshot)) throw formatError("snapshot metadata is missing");
  if (!isRecord(decoded.snapshot.meta)) throw formatError("snapshot layout metadata is missing");
  const meta = decoded.snapshot.meta;
  if (!isStringArray(meta.node_fields) || !Array.isArray(meta.node_types)) {
    throw formatError("node layout metadata is invalid");
  }
  if (!isStringArray(meta.edge_fields) || !Array.isArray(meta.edge_types)) {
    throw formatError("edge layout metadata is invalid");
  }
  if (!isNumberArray(decoded.nodes) || !isNumberArray(decoded.edges) || !isStringArray(decoded.strings)) {
    throw formatError("nodes, edges, or strings are invalid");
  }

  const nodeSize = meta.node_fields.length;
  const edgeSize = meta.edge_fields.length;
  if (nodeSize === 0 || decoded.nodes.length % nodeSize !== 0) {
    throw formatError("the node table is truncated");
  }
  if (edgeSize === 0 || decoded.edges.length % edgeSize !== 0) {
    throw formatError("the edge table is truncated");
  }
  const nodeCount = decoded.nodes.length / nodeSize;
  const edgeCount = decoded.edges.length / edgeSize;
  if (nodeCount === 0) throw formatError("the node table is empty");
  if (nodeCount > 0xFF_FF_FF_FF || decoded.edges.length > 0xFF_FF_FF_FE) {
    throw formatError("the snapshot exceeds analyzer index limits");
  }
  if (decoded.snapshot.node_count !== undefined && decoded.snapshot.node_count !== nodeCount) {
    throw formatError("node_count does not match the node table");
  }
  if (decoded.snapshot.edge_count !== undefined && decoded.snapshot.edge_count !== edgeCount) {
    throw formatError("edge_count does not match the edge table");
  }

  const layout: HeapSnapshotLayout = {
    edgeNameOffset: requireFieldOffset(meta.edge_fields, "name_or_index", "edge_fields"),
    edgeSize,
    edgeToNodeOffset: requireFieldOffset(meta.edge_fields, "to_node", "edge_fields"),
    edgeTypeNames: requireStringTypes(
      meta.edge_types,
      requireFieldOffset(meta.edge_fields, "type", "edge_fields"),
      "edge",
    ),
    edgeTypeOffset: requireFieldOffset(meta.edge_fields, "type", "edge_fields"),
    nodeEdgeCountOffset: requireFieldOffset(meta.node_fields, "edge_count", "node_fields"),
    nodeIdOffset: requireFieldOffset(meta.node_fields, "id", "node_fields"),
    nodeNameOffset: requireFieldOffset(meta.node_fields, "name", "node_fields"),
    nodeSelfSizeOffset: requireFieldOffset(meta.node_fields, "self_size", "node_fields"),
    nodeSize,
    nodeTypeNames: requireStringTypes(
      meta.node_types,
      requireFieldOffset(meta.node_fields, "type", "node_fields"),
      "node",
    ),
    nodeTypeOffset: requireFieldOffset(meta.node_fields, "type", "node_fields"),
  };

  const edgeStarts = new Uint32Array(nodeCount + 1);
  let edgeOffset = 0;
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    edgeStarts[nodeIndex] = edgeOffset;
    const nodeOffset = nodeIndex * nodeSize;
    const outgoingCount = requireInteger(
      numberAt(decoded.nodes, nodeOffset + layout.nodeEdgeCountOffset, `nodes[${nodeIndex}].edge_count`),
      `nodes[${nodeIndex}].edge_count`,
    );
    edgeOffset += outgoingCount * edgeSize;
    if (edgeOffset > decoded.edges.length) throw formatError("node edge counts exceed the edge table");
  }
  edgeStarts[nodeCount] = edgeOffset;
  if (edgeOffset !== decoded.edges.length) {
    throw formatError("node edge counts do not consume the edge table");
  }

  for (let offset = 0; offset < decoded.edges.length; offset += edgeSize) {
    const typeIndex = requireInteger(
      numberAt(decoded.edges, offset + layout.edgeTypeOffset, `edges[${offset}].type`),
      `edges[${offset}].type`,
    );
    if (typeIndex >= layout.edgeTypeNames.length) throw formatError("an edge type index is out of range");
    const toNodeOffset = requireInteger(
      numberAt(decoded.edges, offset + layout.edgeToNodeOffset, `edges[${offset}].to_node`),
      `edges[${offset}].to_node`,
    );
    if (toNodeOffset % nodeSize !== 0 || toNodeOffset / nodeSize >= nodeCount) {
      throw formatError("an edge destination is out of range");
    }
  }

  return {
    edgeCount,
    edgeStarts,
    edges: decoded.edges,
    layout,
    nodeCount,
    nodes: decoded.nodes,
    strings: decoded.strings,
  };
};

const loadSnapshot = async (snapshotPath: string) => parseSnapshot(await readFile(snapshotPath, "utf8"));

const nodeType = (snapshot: ParsedHeapSnapshot, nodeIndex: number): string => {
  const offset = nodeIndex * snapshot.layout.nodeSize;
  const typeIndex = requireInteger(
    numberAt(snapshot.nodes, offset + snapshot.layout.nodeTypeOffset, "node type"),
    "node type",
  );
  const type = snapshot.layout.nodeTypeNames[typeIndex];
  if (type === undefined) throw formatError("a node type index is out of range");
  return type;
};

const nodeName = (snapshot: ParsedHeapSnapshot, nodeIndex: number): string => {
  const offset = nodeIndex * snapshot.layout.nodeSize;
  const nameIndex = requireInteger(
    numberAt(snapshot.nodes, offset + snapshot.layout.nodeNameOffset, "node name"),
    "node name",
  );
  const name = snapshot.strings[nameIndex];
  if (name === undefined) throw formatError("a node name index is out of range");
  return name;
};

const nodeId = (snapshot: ParsedHeapSnapshot, nodeIndex: number): number => {
  const offset = nodeIndex * snapshot.layout.nodeSize;
  return requireInteger(
    numberAt(snapshot.nodes, offset + snapshot.layout.nodeIdOffset, "node id"),
    "node id",
  );
};

const nodeSelfSize = (snapshot: ParsedHeapSnapshot, nodeIndex: number): number => {
  const offset = nodeIndex * snapshot.layout.nodeSize;
  return requireInteger(
    numberAt(snapshot.nodes, offset + snapshot.layout.nodeSelfSizeOffset, "node self_size"),
    "node self_size",
  );
};

const nodeSummary = (snapshot: ParsedHeapSnapshot, nodeIndex: number): HeapNodeSummary => ({
  id: nodeId(snapshot, nodeIndex),
  name: compactString(nodeName(snapshot, nodeIndex), "(anonymous)"),
  selfSize: nodeSelfSize(snapshot, nodeIndex),
  type: compactString(nodeType(snapshot, nodeIndex), "unknown"),
});

const edgeType = (snapshot: ParsedHeapSnapshot, edgeOffset: number): string => {
  const typeIndex = requireInteger(
    numberAt(snapshot.edges, edgeOffset + snapshot.layout.edgeTypeOffset, "edge type"),
    "edge type",
  );
  const type = snapshot.layout.edgeTypeNames[typeIndex];
  if (type === undefined) throw formatError("an edge type index is out of range");
  return type;
};

const edgeTarget = (snapshot: ParsedHeapSnapshot, edgeOffset: number): number =>
  numberAt(snapshot.edges, edgeOffset + snapshot.layout.edgeToNodeOffset, "edge destination") /
  snapshot.layout.nodeSize;

const edgeName = (snapshot: ParsedHeapSnapshot, edgeOffset: number): string => {
  const type = edgeType(snapshot, edgeOffset);
  const encodedName = requireInteger(
    numberAt(snapshot.edges, edgeOffset + snapshot.layout.edgeNameOffset, "edge name"),
    "edge name",
  );
  if (type === "element" || type === "hidden") return String(encodedName);
  const name = snapshot.strings[encodedName];
  if (name === undefined) throw formatError("an edge name index is out of range");
  return compactString(name, "(unnamed)");
};

const insertBounded = <T>(
  items: T[],
  item: T,
  limit: number,
  compare: (left: T, right: T) => number,
): void => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(item, itemAt(items, middle, "bounded result item")) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  items.splice(low, 0, item);
  if (items.length > limit) items.pop();
};

const classKey = (type: string, name: string): string => `${type}\u0000${name}`;

const aggregateSnapshot = (snapshot: ParsedHeapSnapshot, limit: number): SnapshotAggregates => {
  const byClass = new Map<string, ClassAggregate>();
  const byType = new Map<string, HeapTypeSummary>();
  let totalShallowSize = 0;
  for (let nodeIndex = 0; nodeIndex < snapshot.nodeCount; nodeIndex += 1) {
    const type = nodeType(snapshot, nodeIndex);
    const name = nodeName(snapshot, nodeIndex);
    const shallowSize = nodeSelfSize(snapshot, nodeIndex);
    totalShallowSize += shallowSize;
    if (!Number.isSafeInteger(totalShallowSize)) {
      throw formatError("total shallow size exceeds numeric limits");
    }

    const typeAggregate = byType.get(type);
    if (typeAggregate) {
      typeAggregate.count += 1;
      typeAggregate.shallowSize += shallowSize;
    } else {
      byType.set(type, { count: 1, shallowSize, type: compactString(type, "unknown") });
    }

    const key = classKey(type, name);
    const classAggregate = byClass.get(key);
    if (classAggregate) {
      classAggregate.count += 1;
      classAggregate.shallowSize += shallowSize;
    } else {
      byClass.set(key, { count: 1, name, shallowSize, type });
    }
  }

  const topClasses: HeapClassSummary[] = [];
  const compareClasses = (left: HeapClassSummary, right: HeapClassSummary): number =>
    right.shallowSize - left.shallowSize ||
    right.count - left.count ||
    left.type.localeCompare(right.type) ||
    left.name.localeCompare(right.name);
  for (const item of byClass.values()) {
    insertBounded(
      topClasses,
      {
        count: item.count,
        name: compactString(item.name, "(anonymous)"),
        shallowSize: item.shallowSize,
        type: compactString(item.type, "unknown"),
      },
      limit,
      compareClasses,
    );
  }

  const stats: HeapSnapshotStats = {
    edgeCount: snapshot.edgeCount,
    nodeCount: snapshot.nodeCount,
    totalShallowSize,
  };
  return {
    byClass,
    stats,
    summary: {
      ...stats,
      byType: [...byType.values()].sort(
        (left, right) =>
          right.shallowSize - left.shallowSize ||
          right.count - left.count ||
          left.type.localeCompare(right.type),
      ),
      topClasses,
    },
  };
};

const createDiff = (baseline: SnapshotAggregates, current: SnapshotAggregates, limit: number): HeapDiff => {
  const topChanges: HeapClassDelta[] = [];
  const compareChanges = (left: HeapClassDelta, right: HeapClassDelta): number =>
    Math.abs(right.shallowSizeDelta) - Math.abs(left.shallowSizeDelta) ||
    Math.abs(right.countDelta) - Math.abs(left.countDelta) ||
    left.type.localeCompare(right.type) ||
    left.name.localeCompare(right.name);
  const keys = new Set([...baseline.byClass.keys(), ...current.byClass.keys()]);
  for (const key of keys) {
    const before = baseline.byClass.get(key);
    const after = current.byClass.get(key);
    const countDelta = (after?.count ?? 0) - (before?.count ?? 0);
    const shallowSizeDelta = (after?.shallowSize ?? 0) - (before?.shallowSize ?? 0);
    if (countDelta === 0 && shallowSizeDelta === 0) continue;
    const identity = after ?? before;
    if (!identity) continue;
    insertBounded(
      topChanges,
      {
        countDelta,
        currentCount: after?.count ?? 0,
        currentShallowSize: after?.shallowSize ?? 0,
        name: compactString(identity.name, "(anonymous)"),
        shallowSizeDelta,
        type: compactString(identity.type, "unknown"),
      },
      limit,
      compareChanges,
    );
  }
  return {
    baseline: baseline.stats,
    current: current.stats,
    edgeCountDelta: current.stats.edgeCount - baseline.stats.edgeCount,
    nodeCountDelta: current.stats.nodeCount - baseline.stats.nodeCount,
    shallowSizeDelta: current.stats.totalShallowSize - baseline.stats.totalShallowSize,
    topChanges,
  };
};

const indexStrongPredecessors = (snapshot: ParsedHeapSnapshot) => {
  const predecessorCounts = new Uint32Array(snapshot.nodeCount);
  let strongEdgeCount = 0;
  for (let edgeOffset = 0; edgeOffset < snapshot.edges.length; edgeOffset += snapshot.layout.edgeSize) {
    if (edgeType(snapshot, edgeOffset) === "weak") continue;
    const target = edgeTarget(snapshot, edgeOffset);
    const predecessorCount = numberAt(predecessorCounts, target, "predecessor count");
    if (predecessorCount === 0xFF_FF_FF_FF) throw formatError("a node has too many predecessors");
    predecessorCounts[target] = predecessorCount + 1;
    strongEdgeCount += 1;
  }
  if (strongEdgeCount > 0xFF_FF_FF_FF) throw formatError("the strong edge graph exceeds analyzer limits");

  const predecessorOffsets = new Uint32Array(snapshot.nodeCount + 1);
  for (let index = 0; index < snapshot.nodeCount; index += 1) {
    predecessorOffsets[index + 1] =
      numberAt(predecessorOffsets, index, "predecessor offset") +
      numberAt(predecessorCounts, index, "predecessor count");
  }
  const predecessorWriteOffsets = predecessorOffsets.slice(0, snapshot.nodeCount);
  const predecessors = new Uint32Array(strongEdgeCount);
  for (let source = 0; source < snapshot.nodeCount; source += 1) {
    const edgeEnd = numberAt(snapshot.edgeStarts, source + 1, "node edge end");
    for (
      let edgeOffset = numberAt(snapshot.edgeStarts, source, "node edge start");
      edgeOffset < edgeEnd;
      edgeOffset += snapshot.layout.edgeSize
    ) {
      if (edgeType(snapshot, edgeOffset) === "weak") continue;
      const target = edgeTarget(snapshot, edgeOffset);
      const writeOffset = numberAt(predecessorWriteOffsets, target, "predecessor write offset");
      predecessors[writeOffset] = source;
      predecessorWriteOffsets[target] = writeOffset + 1;
    }
  }

  return { predecessorOffsets, predecessors };
};

const buildDominatorAnalysis = (snapshot: ParsedHeapSnapshot, limit: number): DominatorAnalysis => {
  const { predecessorOffsets, predecessors } = indexStrongPredecessors(snapshot);

  const dfsNumber = new Uint32Array(snapshot.nodeCount);
  const vertex = new Uint32Array(snapshot.nodeCount + 1);
  const parent = new Uint32Array(snapshot.nodeCount + 1);
  const parentEdge = new Uint32Array(snapshot.nodeCount + 1);
  const stackNodes = new Uint32Array(snapshot.nodeCount);
  const stackEdges = new Uint32Array(snapshot.nodeCount);
  const stackEnds = new Uint32Array(snapshot.nodeCount);
  let reachableCount = 1;
  let stackDepth = 1;
  dfsNumber[0] = 1;
  vertex[1] = 0;
  stackNodes[0] = 0;
  stackEdges[0] = numberAt(snapshot.edgeStarts, 0, "root edge start");
  stackEnds[0] = numberAt(snapshot.edgeStarts, 1, "root edge end");
  while (stackDepth > 0) {
    const stackIndex = stackDepth - 1;
    const nextEdge = numberAt(stackEdges, stackIndex, "DFS edge cursor");
    if (nextEdge >= numberAt(stackEnds, stackIndex, "DFS edge end")) {
      stackDepth -= 1;
      continue;
    }
    const edgeOffset = nextEdge;
    stackEdges[stackIndex] = edgeOffset + snapshot.layout.edgeSize;
    if (edgeType(snapshot, edgeOffset) === "weak") continue;
    const target = edgeTarget(snapshot, edgeOffset);
    if (numberAt(dfsNumber, target, "DFS number") !== 0) continue;
    reachableCount += 1;
    dfsNumber[target] = reachableCount;
    vertex[reachableCount] = target;
    parent[reachableCount] = numberAt(
      dfsNumber,
      numberAt(stackNodes, stackIndex, "DFS stack node"),
      "DFS parent number",
    );
    parentEdge[reachableCount] = edgeOffset + 1;
    stackNodes[stackDepth] = target;
    stackEdges[stackDepth] = numberAt(snapshot.edgeStarts, target, "target edge start");
    stackEnds[stackDepth] = numberAt(snapshot.edgeStarts, target + 1, "target edge end");
    stackDepth += 1;
  }

  const semi = new Uint32Array(reachableCount + 1);
  const immediateDominator = new Uint32Array(reachableCount + 1);
  const ancestor = new Uint32Array(reachableCount + 1);
  const label = new Uint32Array(reachableCount + 1);
  const bucketHead = new Uint32Array(reachableCount + 1);
  const bucketNext = new Uint32Array(reachableCount + 1);
  const compressionStack = new Uint32Array(reachableCount + 1);
  for (let index = 1; index <= reachableCount; index += 1) {
    semi[index] = index;
    label[index] = index;
  }

  const evaluate = (value: number): number => {
    if (numberAt(ancestor, value, "ancestor") === 0) return numberAt(label, value, "label");
    let cursor = value;
    let length = 0;
    while (numberAt(ancestor, cursor, "ancestor") !== 0) {
      const cursorAncestor = numberAt(ancestor, cursor, "ancestor");
      if (numberAt(ancestor, cursorAncestor, "ancestor") === 0) break;
      compressionStack[length] = cursor;
      length += 1;
      cursor = cursorAncestor;
    }
    while (length > 0) {
      length -= 1;
      const item = numberAt(compressionStack, length, "compression item");
      const itemAncestor = numberAt(ancestor, item, "item ancestor");
      const ancestorLabel = numberAt(label, itemAncestor, "ancestor label");
      const itemLabel = numberAt(label, item, "item label");
      if (
        numberAt(semi, ancestorLabel, "ancestor semi-dominator") < numberAt(semi, itemLabel, "semi-dominator")
      ) {
        label[item] = ancestorLabel;
      }
      ancestor[item] = numberAt(ancestor, itemAncestor, "ancestor parent");
    }
    return numberAt(label, value, "label");
  };

  for (let current = reachableCount; current >= 2; current -= 1) {
    const currentNode = numberAt(vertex, current, "DFS vertex");
    const predecessorEnd = numberAt(predecessorOffsets, currentNode + 1, "predecessor end");
    for (
      let predecessorOffset = numberAt(predecessorOffsets, currentNode, "predecessor start");
      predecessorOffset < predecessorEnd;
      predecessorOffset += 1
    ) {
      const predecessorDfs = numberAt(
        dfsNumber,
        numberAt(predecessors, predecessorOffset, "predecessor"),
        "predecessor DFS number",
      );
      if (predecessorDfs === 0) continue;
      const candidate = evaluate(predecessorDfs);
      const candidateSemi = numberAt(semi, candidate, "candidate semi-dominator");
      if (candidateSemi < numberAt(semi, current, "semi-dominator")) semi[current] = candidateSemi;
    }
    const currentSemi = numberAt(semi, current, "semi-dominator");
    bucketNext[current] = numberAt(bucketHead, currentSemi, "semi-dominator bucket");
    bucketHead[currentSemi] = current;
    const currentParent = numberAt(parent, current, "DFS parent");
    ancestor[current] = currentParent;

    let bucketItem = numberAt(bucketHead, currentParent, "parent bucket");
    bucketHead[currentParent] = 0;
    while (bucketItem !== 0) {
      const next = numberAt(bucketNext, bucketItem, "bucket item");
      const candidate = evaluate(bucketItem);
      immediateDominator[bucketItem] =
        (
          numberAt(semi, candidate, "candidate semi-dominator") <
          numberAt(semi, bucketItem, "item semi-dominator")
        ) ?
          candidate
        : currentParent;
      bucketItem = next;
    }
  }
  for (let current = 2; current <= reachableCount; current += 1) {
    const dominator = numberAt(immediateDominator, current, "immediate dominator");
    if (dominator !== numberAt(semi, current, "semi-dominator")) {
      immediateDominator[current] = numberAt(immediateDominator, dominator, "transitive immediate dominator");
    }
  }

  const retainedSizes = new Float64Array(reachableCount + 1);
  for (let current = 1; current <= reachableCount; current += 1) {
    retainedSizes[current] = nodeSelfSize(snapshot, numberAt(vertex, current, "DFS vertex"));
  }
  for (let current = reachableCount; current >= 2; current -= 1) {
    const dominator = numberAt(immediateDominator, current, "immediate dominator");
    retainedSizes[dominator] =
      numberAt(retainedSizes, dominator, "dominator retained size") +
      numberAt(retainedSizes, current, "retained size");
  }
  const totalRetainedSize = numberAt(retainedSizes, 1, "root retained size");

  const candidates: number[] = [];
  const compareCandidates = (left: number, right: number): number =>
    numberAt(retainedSizes, right, "candidate retained size") -
      numberAt(retainedSizes, left, "candidate retained size") ||
    nodeSelfSize(snapshot, numberAt(vertex, right, "candidate vertex")) -
      nodeSelfSize(snapshot, numberAt(vertex, left, "candidate vertex")) ||
    nodeId(snapshot, numberAt(vertex, left, "candidate vertex")) -
      nodeId(snapshot, numberAt(vertex, right, "candidate vertex"));
  for (let current = 2; current <= reachableCount; current += 1) {
    if (nodeType(snapshot, numberAt(vertex, current, "candidate vertex")) === "synthetic") continue;
    insertBounded(candidates, current, limit, compareCandidates);
  }

  return {
    dominators: candidates.map((dfsIndex) => ({
      dfsIndex,
      result: {
        ...nodeSummary(snapshot, numberAt(vertex, dfsIndex, "dominator vertex")),
        retainedPercent:
          totalRetainedSize === 0 ? 0 : (
            Math.round(
              (numberAt(retainedSizes, dfsIndex, "dominator retained size") / totalRetainedSize) * 10_000,
            ) / 100
          ),
        retainedSize: numberAt(retainedSizes, dfsIndex, "dominator retained size"),
      },
    })),
    parent,
    parentEdge,
    vertex,
    dfsNumber,
    retainedSizes,
  };
};

const retainingPath = (
  snapshot: ParsedHeapSnapshot,
  analysis: DominatorAnalysis,
  dominator: DominatorAnalysis["dominators"][number],
  maximumDepth: number,
): HeapRetainingPath => {
  const targetToRoot: HeapRetainingPathStep[] = [];
  let current = dominator.dfsIndex;
  while (current !== 0 && targetToRoot.length < maximumDepth) {
    const step: HeapRetainingPathStep = nodeSummary(
      snapshot,
      numberAt(analysis.vertex, current, "retaining path vertex"),
    );
    const encodedParentEdge = numberAt(analysis.parentEdge, current, "retaining path parent edge");
    targetToRoot.push(
      encodedParentEdge === 0 ? step : (
        {
          ...step,
          edgeFromParent: {
            name: edgeName(snapshot, encodedParentEdge - 1),
            type: compactString(edgeType(snapshot, encodedParentEdge - 1), "unknown"),
          },
        }
      ),
    );
    current = numberAt(analysis.parent, current, "retaining path parent");
  }
  return {
    target: dominator.result,
    targetToRoot,
    truncated: current !== 0,
  };
};

const collectBaseline = async (snapshotPath: string, limit: number): Promise<SnapshotAggregates> =>
  aggregateSnapshot(await loadSnapshot(snapshotPath), limit);

const heapCursorSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    querySha256: z.string().regex(/^[0-9a-f]{64}$/u),
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const hashHeapQuery = (query: HeapQueryRequest["query"]) =>
  createHash("sha256").update(JSON.stringify(query)).digest("hex");

const readQueryOffset = (request: HeapQueryRequest, snapshotSha256: string) => {
  if (request.cursor === undefined) return 0;

  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid heap query cursor");
  }

  const cursor = heapCursorSchema.parse(decoded);
  const hasChangedQuery = cursor.querySha256 !== hashHeapQuery(request.query);
  const hasChangedSnapshot = cursor.snapshotSha256 !== snapshotSha256;
  if (hasChangedQuery || hasChangedSnapshot) {
    throw new Error("Heap query cursor belongs to a different query or snapshot contents");
  }

  return cursor.offset;
};

const selectQueryPage = <Row>(input: {
  offset: number;
  request: HeapQueryRequest;
  rows: Row[];
  snapshotSha256: string;
}) => {
  if (input.offset > input.rows.length) {
    throw new Error("Heap query cursor is outside the result set");
  }

  const end = Math.min(input.offset + input.request.limit, input.rows.length);
  const nextCursor =
    end < input.rows.length ?
      Buffer.from(
        JSON.stringify({
          offset: end,
          querySha256: hashHeapQuery(input.request.query),
          snapshotSha256: input.snapshotSha256,
        }),
      ).toString("base64url")
    : null;
  return {
    rows: input.rows.slice(input.offset, end),
    nextCursor,
    snapshotSha256: input.snapshotSha256,
    totalMatches: input.rows.length,
  };
};

const queryHeapObjects = (snapshot: ParsedHeapSnapshot, request: HeapQueryRequest) => {
  const query = request.query;
  if (query.kind !== "objects") throw new Error("Expected an objects query");

  const dominators = buildDominatorAnalysis(snapshot, 0);
  const rows: Extract<HeapQueryResult, { kind: "objects" }>["rows"] = [];
  const className = query.className?.toLowerCase();

  for (let index = 0; index < snapshot.nodeCount; index += 1) {
    if (nodeType(snapshot, index) === "synthetic") continue;
    if (className !== undefined && !nodeName(snapshot, index).toLowerCase().includes(className)) continue;
    if (query.propertyName !== undefined) {
      let hasProperty = false;
      const edgeEnd = numberAt(snapshot.edgeStarts, index + 1, "node edge end");

      for (
        let offset = numberAt(snapshot.edgeStarts, index, "node edge start");
        offset < edgeEnd;
        offset += snapshot.layout.edgeSize
      ) {
        const nameIndex = numberAt(snapshot.edges, offset + snapshot.layout.edgeNameOffset, "property name");
        const hasMatchingProperty =
          edgeType(snapshot, offset) === "property" && snapshot.strings[nameIndex] === query.propertyName;
        if (hasMatchingProperty) {
          hasProperty = true;
          break;
        }
      }

      if (!hasProperty) continue;
    }

    const dfsIndex = numberAt(dominators.dfsNumber, index, "DFS number");
    const retainedSize =
      dfsIndex === 0 ? null : numberAt(dominators.retainedSizes, dfsIndex, "retained size");
    const isBelowRetainedMinimum =
      query.minRetainedBytes !== undefined &&
      (retainedSize === null || retainedSize < query.minRetainedBytes);
    if (isBelowRetainedMinimum) continue;

    rows.push({ ...nodeSummary(snapshot, index), retainedSize });
  }

  rows.sort((left, right) => {
    if (query.sort === "id") return left.id - right.id;
    if (query.sort === "selfSize") return right.selfSize - left.selfSize || left.id - right.id;
    return (
      (right.retainedSize ?? -1) - (left.retainedSize ?? -1) ||
      right.selfSize - left.selfSize ||
      left.id - right.id
    );
  });
  return rows;
};

const queryHeapEdges = (snapshot: ParsedHeapSnapshot, request: HeapQueryRequest) => {
  const query = request.query;
  if (query.kind !== "edges") throw new Error("Expected an edges query");

  let source: number | undefined;

  for (let index = 0; index < snapshot.nodeCount; index += 1) {
    if (nodeId(snapshot, index) === query.nodeId) {
      source = index;
      break;
    }
  }

  if (source === undefined) {
    throw new Error(`Heap node ${query.nodeId} does not exist in this snapshot`);
  }

  const dominators = buildDominatorAnalysis(snapshot, 0);
  const rows: Extract<HeapQueryResult, { kind: "edges" }>["rows"] = [];
  const edgeEnd = numberAt(snapshot.edgeStarts, source + 1, "node edge end");

  for (
    let offset = numberAt(snapshot.edgeStarts, source, "node edge start");
    offset < edgeEnd;
    offset += snapshot.layout.edgeSize
  ) {
    const target = edgeTarget(snapshot, offset);
    const type = nodeType(snapshot, target);
    const isPrimitive = [
      "bigint",
      "concatenated string",
      "number",
      "sliced string",
      "string",
      "symbol",
    ].includes(type);
    if (query.excludePrimitives && isPrimitive) continue;

    const dfsIndex = numberAt(dominators.dfsNumber, target, "DFS number");
    const retainedSize =
      dfsIndex === 0 ? null : numberAt(dominators.retainedSizes, dfsIndex, "retained size");
    const isBelowRetainedMinimum =
      query.minRetainedBytes !== undefined &&
      (retainedSize === null || retainedSize < query.minRetainedBytes);
    if (isBelowRetainedMinimum) continue;

    rows.push({
      name: edgeName(snapshot, offset),
      type: edgeType(snapshot, offset),
      target: { ...nodeSummary(snapshot, target), retainedSize },
    });
  }

  rows.sort((left, right) => {
    if (query.sort === "name") {
      return left.name.localeCompare(right.name, "en") || left.target.id - right.target.id;
    }
    return (
      (right.target.retainedSize ?? -1) - (left.target.retainedSize ?? -1) ||
      left.name.localeCompare(right.name, "en") ||
      left.target.id - right.target.id
    );
  });
  return rows;
};

const requireHeapMethod = (owner: unknown, name: string) => {
  if (typeof owner !== "object" || owner === null) {
    throw new Error("Invalid DevTools heap processor");
  }

  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== "function") {
    throw new TypeError(`DevTools heap processor did not provide ${name}`);
  }

  return method;
};

const collectHeapContexts = async (source: string) => {
  const frontend = await loadHeapFrontend();
  const loaderNamespace = frontend.HeapSnapshotLoader;
  const heapNamespace = frontend.HeapSnapshot;
  const loader: unknown = Reflect.construct(requireHeapMethod(loaderNamespace, "HeapSnapshotLoader"), [
    { sendEvent: () => undefined },
  ]);
  const channel = new MessageChannel();

  try {
    Reflect.construct(requireHeapMethod(heapNamespace, "SecondaryInitManager"), [channel.port2]);
    Reflect.apply(requireHeapMethod(loader, "write"), loader, [source]);
    Reflect.apply(requireHeapMethod(loader, "close"), loader, []);
    const snapshot: unknown = await Reflect.apply(requireHeapMethod(loader, "buildSnapshot"), loader, [
      channel.port1,
    ]);
    const nativeSizes: unknown = Reflect.apply(
      requireHeapMethod(snapshot, "getNativeContextSizes"),
      snapshot,
      [],
    );
    const retention: unknown = Reflect.apply(
      requireHeapMethod(snapshot, "getRetainedByContextSummary"),
      snapshot,
      [],
    );
    if (!isRecord(nativeSizes) || !Array.isArray(nativeSizes.nativeContexts)) {
      throw new Error("DevTools native context attribution is invalid");
    }

    const rows = nativeSizes.nativeContexts.map((value: unknown) => {
      if (!isRecord(value)) {
        throw new Error("DevTools native context is invalid");
      }

      return {
        nodeId: value.nodeId,
        nodeName: value.nodeName,
        attributedSize: value.attributedSize,
        retainedSize: value.retainedSize,
        selfSize: value.selfSize,
      };
    });
    const result = heapContextAttributionSchema.parse({
      rows,
      sharedSize: nativeSizes.sharedSize,
      noAttributionSize: nativeSizes.noAttributionSize,
      retention,
    });

    result.rows = result.rows.map((row) => ({
      ...row,
      nodeName: compactString(row.nodeName, "(anonymous)"),
    }));
    result.rows.sort(
      (left, right) => right.attributedSize - left.attributedSize || left.nodeId - right.nodeId,
    );
    return result;
  } finally {
    try {
      Reflect.apply(requireHeapMethod(loader, "dispose"), loader, []);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }
};

export const queryHeapSnapshot = async (request: HeapQueryRequest) => {
  const bytes = await readFile(request.snapshotPath);
  const snapshotSha256 = createHash("sha256").update(bytes).digest("hex");
  const offset = readQueryOffset(request, snapshotSha256);
  const source = bytes.toString("utf8");
  const snapshot = parseSnapshot(source);

  if (request.query.kind === "objects") {
    return {
      kind: "objects",
      ...selectQueryPage({ rows: queryHeapObjects(snapshot, request), offset, request, snapshotSha256 }),
    } satisfies HeapQueryResult;
  }

  if (request.query.kind === "edges") {
    return {
      kind: "edges",
      nodeId: request.query.nodeId,
      ...selectQueryPage({ rows: queryHeapEdges(snapshot, request), offset, request, snapshotSha256 }),
    } satisfies HeapQueryResult;
  }

  const contexts = await collectHeapContexts(source);
  return {
    kind: "contexts",
    ...contexts,
    ...selectQueryPage({ rows: contexts.rows, offset, request, snapshotSha256 }),
  } satisfies HeapQueryResult;
};

export const analyzeHeapSnapshot = async (request: HeapAnalysisRequest): Promise<HeapAnalysisResult> => {
  const selectedModes = new Set(request.modes);
  const baseline =
    selectedModes.has("diff") && request.baselineSnapshotPath ?
      await collectBaseline(request.baselineSnapshotPath, request.limit)
    : undefined;
  if (baseline && typeof Bun.gc === "function") Bun.gc(true);

  const snapshot = await loadSnapshot(request.snapshotPath);
  const aggregates = aggregateSnapshot(snapshot, request.limit);
  const needsDominators = selectedModes.has("dominators") || selectedModes.has("retainers");
  const dominatorAnalysis = needsDominators ? buildDominatorAnalysis(snapshot, request.limit) : undefined;

  return {
    ...(baseline ? { diff: createDiff(baseline, aggregates, request.limit) } : {}),
    ...(selectedModes.has("dominators") && dominatorAnalysis ?
      { dominators: dominatorAnalysis.dominators.map(({ result }) => result) }
    : {}),
    ...(selectedModes.has("retainers") && dominatorAnalysis ?
      {
        retainingPaths: dominatorAnalysis.dominators.map((dominator) =>
          retainingPath(snapshot, dominatorAnalysis, dominator, request.maxRetainingPathDepth),
        ),
      }
    : {}),
    snapshot: aggregates.stats,
    ...(selectedModes.has("summary") ? { summary: aggregates.summary } : {}),
  };
};
