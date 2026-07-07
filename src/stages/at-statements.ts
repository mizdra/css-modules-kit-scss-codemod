import type { Diagnostic } from '../core/diagnostic.ts';
import type { StageTransform } from './types.ts';

/**
 * Removes `@error` / `@warn` / `@debug` at-rules at any nesting depth, recording each removed
 * at-rule's content as a log entry (design doc §6 "@error / @warn / @debug" row; §8.1 stage 2
 * `at-statements`; §13.2 Step 11).
 *
 * These are compile-time-only Sass constructs that never produce CSS output: `@debug`/`@warn`
 * print to the build log and `@error` aborts the Sass compilation. A codebase where `@error` is
 * actually reached would already fail to compile — `analyze`'s compile check ([§13.2](#132)
 * Step 7) reports that separately — so removing the statement here is constructively equivalent
 * to the previous build output (design doc §8.1 "安全性" column).
 *
 * `root.walkAtRules` visits at-rules regardless of nesting depth (top level, inside a rule,
 * inside `@mixin`/`@media`, etc.), so a single filtered walk covers every location. Removal
 * during `walkAtRules` is safe (postcss adjusts the walk to skip removed nodes).
 *
 * Idempotent: once an at-rule is removed there is nothing left to remove on a later pass.
 */
export const transformAtStatements: StageTransform = (root, file) => {
  const logs: Diagnostic[] = [];

  root.walkAtRules(/^(?:error|warn|debug)$/u, (atrule) => {
    logs.push({
      file,
      line: atrule.source?.start?.line,
      column: atrule.source?.start?.column,
      syntax: `@${atrule.name}`,
      message: `removed @${atrule.name} ${atrule.params}`,
    });
    atrule.remove();
  });

  return { diagnostics: [], logs };
};
