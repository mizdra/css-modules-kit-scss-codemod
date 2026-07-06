/** Milestone in which a stage's conversion becomes implemented. */
export type Milestone = "M0" | "M1" | "M2";

export interface StageInfo {
  readonly name: string;
  readonly milestone: Milestone;
}

/** All `convert` stages, in the order they should be applied. */
export const STAGES: readonly StageInfo[] = [
  { name: "comments", milestone: "M0" },
  { name: "at-statements", milestone: "M0" },
  { name: "nesting", milestone: "M0" },
  { name: "to-css", milestone: "M0" },
  { name: "expressions", milestone: "M1" },
  { name: "modules", milestone: "M1" },
  { name: "colors", milestone: "M2" },
  { name: "mixins", milestone: "M2" },
  { name: "interpolation", milestone: "M2" },
];

export const STAGE_NAMES: readonly string[] = STAGES.map((stage) => stage.name);

export function findStage(name: string): StageInfo | undefined {
  return STAGES.find((stage) => stage.name === name);
}
