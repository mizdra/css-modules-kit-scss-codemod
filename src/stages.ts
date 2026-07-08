/** Milestone in which a stage's conversion becomes implemented. */
export type Milestone = 'M0' | 'M1' | 'M2';

/** How a stage's conversion is verified not to change behavior (design doc §8.1, "安全性" column). */
export type StageSafety = 'constructively equivalent' | 'machine-verified' | 'verified by end-to-end verify';

export interface StageInfo {
  readonly name: string;
  readonly milestone: Milestone;
  readonly safety: StageSafety;
}

/** All `convert` stages, in the order they should be applied. */
export const STAGES = [
  { name: 'comments', milestone: 'M0', safety: 'constructively equivalent' },
  { name: 'at-statements', milestone: 'M0', safety: 'constructively equivalent' },
  { name: 'to-css', milestone: 'M0', safety: 'verified by end-to-end verify' },
  { name: 'expressions', milestone: 'M1', safety: 'machine-verified' },
  { name: 'modules', milestone: 'M1', safety: 'verified by end-to-end verify' },
  { name: 'colors', milestone: 'M2', safety: 'verified by end-to-end verify' },
  { name: 'mixins', milestone: 'M2', safety: 'verified by end-to-end verify' },
  { name: 'interpolation', milestone: 'M2', safety: 'verified by end-to-end verify' },
] as const satisfies readonly StageInfo[];

/** Name of a known stage. Internal producers use this union; user input stays `string` (see `findStage`). */
export type StageName = (typeof STAGES)[number]['name'];

export const STAGE_NAMES: readonly string[] = STAGES.map((stage) => stage.name);

/** Accepts arbitrary user input, hence `string` rather than `StageName`. */
export function findStage(name: string): StageInfo | undefined {
  return STAGES.find((stage) => stage.name === name);
}
