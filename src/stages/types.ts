import type { Root } from 'postcss';
import type { Diagnostic } from '../core/diagnostic.ts';

/** Outcome of applying a `StageTransform` to a single file's AST. */
export interface StageTransformResult {
  /** Precondition failures for this file (design doc §8.3). A non-empty result blocks writing for the whole run. */
  readonly diagnostics: readonly Diagnostic[];
  /** Informational (non-error) notes the convert command writes to stderr (e.g. removed `@warn` content). */
  readonly logs: readonly Diagnostic[];
}

/**
 * A single stage's conversion (design doc §8). Mutates `root` in place; the caller re-stringifies
 * it with `stringifyScss` afterwards. Must be idempotent: applying a transform to the output of a
 * previous application of the same transform must be a no-op (design doc §8.3).
 */
export type StageTransform = (root: Root, file: string) => StageTransformResult;
