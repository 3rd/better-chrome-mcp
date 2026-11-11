import type { REACT_PROFILE_ANALYSIS_METRICS } from "../runtime/react-inspection-protocol";
import { isRecord } from "../../platform/records";

type ReactProfileChangeSummary = {
  context: number;
  hooks: number;
  mounts: number;
  props: number;
  records: number;
  state: number;
};

export type ReactProfileAnalysisRow = Readonly<{
  changeDescriptions: readonly Readonly<Record<string, unknown>>[];
  changeSummary: ReactProfileChangeSummary | null;
  commitCount: number;
  componentId: string;
  displayName: string | null;
  effectDuration: number | null;
  maximumRenderDuration: number;
  renderCount: number;
  slowestCommit: number;
  slowestCommitIndex: number;
  totalInclusiveDuration: number;
  totalSelfDuration: number;
}>;

const profileMapEntries = (value: unknown): readonly (readonly [unknown, unknown])[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): readonly (readonly [unknown, unknown])[] =>
    Array.isArray(entry) && entry.length === 2 ? [[entry[0], entry[1]]] : [],
  );
};

const profileRootData = (
  value: unknown,
  roots: Record<string, unknown>[] = [],
): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    for (const entry of value) profileRootData(entry, roots);
    return roots;
  }
  if (!isRecord(value)) return roots;
  if (Array.isArray(value.commitData)) roots.push(value);
  for (const entry of Object.values(value)) profileRootData(entry, roots);
  return roots;
};

const readFiniteDuration = (value: unknown) => {
  const isFiniteDuration = typeof value === "number" && Number.isFinite(value);
  if (isFiniteDuration) return value;

  return undefined;
};

const summarizeProfileChange = (
  summary: ReactProfileChangeSummary,
  description: Record<string, unknown>,
) => ({
  context:
    summary.context +
    Number(
      description.context === true || (Array.isArray(description.context) && description.context.length > 0),
    ),
  hooks: summary.hooks + Number(description.didHooksChange === true),
  mounts: summary.mounts + Number(description.isFirstMount === true),
  props: summary.props + Number(Array.isArray(description.props) && description.props.length > 0),
  records: summary.records + 1,
  state: summary.state + Number(Array.isArray(description.state) && description.state.length > 0),
});

export const analyzeReactProfile = (profile: unknown): readonly ReactProfileAnalysisRow[] => {
  const components = new Map<
    string,
    {
      changeDescriptions: Readonly<Record<string, unknown>>[];
      changeSummary: ReactProfileChangeSummary;
      commitCount: number;
      componentId: string;
      displayName: string | null;
      effectDuration: number;
      hasEffectDuration: boolean;
      maximumRenderDuration: number;
      renderCount: number;
      slowestCommit: number;
      slowestCommitIndex: number;
      totalInclusiveDuration: number;
      totalSelfDuration: number;
    }
  >();
  for (const root of profileRootData(profile)) {
    const displayNames = new Map(profileMapEntries(root.displayNames));
    const commits = Array.isArray(root.commitData) ? root.commitData : [];
    for (const [commitIndex, commit] of commits.entries()) {
      if (!isRecord(commit)) continue;
      const inclusive = new Map(
        profileMapEntries(commit.fiberActualDurations).map(([id, duration]) => [String(id), duration]),
      );
      const selfDurationsByComponentId = new Map(
        profileMapEntries(commit.fiberSelfDurations).map(([id, duration]) => [String(id), duration]),
      );
      const changeDescriptions = new Map(
        profileMapEntries(commit.changeDescriptions).map(([id, description]) => [String(id), description]),
      );
      const commitDuration = readFiniteDuration(commit.duration) ?? 0;
      const effectDuration = readFiniteDuration(commit.effectDuration);
      for (const [rawId, durationValue] of inclusive) {
        if (typeof durationValue !== "number" || !Number.isFinite(durationValue)) continue;
        const componentId = rawId;
        const displayName = displayNames.get(componentId);
        const current = components.get(componentId) ?? {
          changeDescriptions: [],
          changeSummary: { context: 0, hooks: 0, mounts: 0, props: 0, records: 0, state: 0 },
          commitCount: 0,
          componentId,
          displayName: typeof displayName === "string" ? displayName : null,
          effectDuration: 0,
          hasEffectDuration: false,
          maximumRenderDuration: 0,
          renderCount: 0,
          slowestCommit: commitDuration,
          slowestCommitIndex: commitIndex,
          totalInclusiveDuration: 0,
          totalSelfDuration: 0,
        };
        const selfDurationValue = selfDurationsByComponentId.get(rawId);
        const selfDuration = readFiniteDuration(selfDurationValue) ?? 0;
        current.commitCount += 1;
        current.renderCount += 1;
        current.totalInclusiveDuration += durationValue;
        current.totalSelfDuration += selfDuration;
        if (effectDuration !== undefined) {
          current.effectDuration += effectDuration;
          current.hasEffectDuration = true;
        }
        const changeDescription = changeDescriptions.get(rawId);
        if (isRecord(changeDescription)) {
          current.changeDescriptions.push({ ...changeDescription, commitIndex });
          current.changeSummary = summarizeProfileChange(current.changeSummary, changeDescription);
        }
        if (durationValue > current.maximumRenderDuration) current.maximumRenderDuration = durationValue;
        if (commitDuration > current.slowestCommit) {
          current.slowestCommit = commitDuration;
          current.slowestCommitIndex = commitIndex;
        }
        components.set(componentId, current);
      }
    }
  }
  return [...components.values()].map((component) => ({
    changeDescriptions: component.changeDescriptions,
    changeSummary: component.changeSummary.records === 0 ? null : component.changeSummary,
    commitCount: component.commitCount,
    componentId: component.componentId,
    displayName: component.displayName,
    effectDuration: component.hasEffectDuration ? component.effectDuration : null,
    maximumRenderDuration: component.maximumRenderDuration,
    renderCount: component.renderCount,
    slowestCommit: component.slowestCommit,
    slowestCommitIndex: component.slowestCommitIndex,
    totalInclusiveDuration: component.totalInclusiveDuration,
    totalSelfDuration: component.totalSelfDuration,
  }));
};

const ROW_FIELD_BY_METRIC = {
  "commit-participation": "commitCount",
  "effect-duration": "effectDuration",
  "maximum-render-duration": "maximumRenderDuration",
  "render-count": "renderCount",
  "slowest-commit": "slowestCommit",
  "total-inclusive-duration": "totalInclusiveDuration",
  "total-self-duration": "totalSelfDuration",
} as const;

export const rankReactProfileRows = (
  rows: readonly ReactProfileAnalysisRow[],
  primaryMetric: (typeof REACT_PROFILE_ANALYSIS_METRICS)[number],
) => {
  const primaryField = ROW_FIELD_BY_METRIC[primaryMetric];

  return [...rows].sort((left, right) => {
    const leftValue = typeof left[primaryField] === "number" ? left[primaryField] : Number.NEGATIVE_INFINITY;
    const rightValue =
      typeof right[primaryField] === "number" ? right[primaryField] : Number.NEGATIVE_INFINITY;
    if (leftValue !== rightValue) return rightValue - leftValue;

    return String(left.componentId).localeCompare(String(right.componentId));
  });
};
