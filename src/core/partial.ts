import path from 'node:path';
import type { AtRule, Declaration, Root } from 'postcss';
import { isPlainCssImport } from './classify.ts';
import type { Diagnostic } from './diagnostic.ts';

/** Whether `file`'s basename starts with `_` (design doc §9.1). Directory segments named `_foo` don't count. */
export function isPartial(file: string): boolean {
  return path.basename(file).startsWith('_');
}

export type PartialClassification = 'definition-only' | 'style-emitting' | 'mixed';

export interface PartialClassificationResult {
  readonly file: string;
  readonly classification: PartialClassification;
  /** Only set for 'mixed': position of the first node of the later-appearing category. */
  readonly mixedAt?: { readonly line?: number; readonly column?: number; readonly syntax: string };
}

type NodeCategory = 'definition' | 'neutral' | 'emitting';

const DEFINITION_AT_RULES: ReadonlySet<string> = new Set(['mixin', 'function', 'use', 'forward']);
const NEUTRAL_AT_RULES: ReadonlySet<string> = new Set(['error', 'warn', 'debug', 'charset']);

interface NodeStart {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

function nodeStart(node: { source?: { start?: { line: number; column: number } } }): NodeStart {
  const start = node.source?.start;
  return { line: start?.line, column: start?.column };
}

/** Label used for `mixedAt.syntax` and the diagnostic's `syntax` field when the node is a declaration. */
function declSyntaxLabel(decl: Declaration): string {
  return decl.prop.startsWith('$') ? 'variable declaration' : 'declaration';
}

/** Label used for `mixedAt.syntax` when the node is an at-rule. */
function atRuleSyntaxLabel(atrule: AtRule): string {
  return `@${atrule.name}`;
}

/**
 * Categorizes a single top-level node per the whitelist in design doc §9.1: `definition`
 * (kept as a definition-only construct), `neutral` (produces no CSS and never flips the
 * classification), or `emitting` (produces CSS output — the DEFAULT, fail-closed, category).
 */
function categorize(node: Root['nodes'][number]): { readonly category: NodeCategory; readonly syntax: string } {
  if (node.type === 'comment') {
    return { category: 'neutral', syntax: 'comment' };
  }
  if (node.type === 'decl') {
    if (node.prop.startsWith('$')) {
      return { category: 'definition', syntax: declSyntaxLabel(node) };
    }
    return { category: 'emitting', syntax: declSyntaxLabel(node) };
  }
  if (node.type === 'atrule') {
    if (DEFINITION_AT_RULES.has(node.name)) {
      return { category: 'definition', syntax: atRuleSyntaxLabel(node) };
    }
    if (node.name === 'import') {
      // A Sass @import is treated like @use: emission responsibility belongs to the imported
      // file's own classification (design doc §9.1). A plain-CSS @import emits CSS itself.
      return isPlainCssImport(node.params)
        ? { category: 'emitting', syntax: atRuleSyntaxLabel(node) }
        : { category: 'definition', syntax: atRuleSyntaxLabel(node) };
    }
    if (NEUTRAL_AT_RULES.has(node.name)) {
      return { category: 'neutral', syntax: atRuleSyntaxLabel(node) };
    }
    // Every other at-rule (media, supports, keyframes, font-face, include, control-flow,
    // at-root, unknown at-rules, ...) emits CSS or has CSS-shaped output responsibility. Fail-closed.
    return { category: 'emitting', syntax: atRuleSyntaxLabel(node) };
  }
  // node.type === 'rule'
  return { category: 'emitting', syntax: 'style rule' };
}

/**
 * Classifies a partial file as `definition-only`, `style-emitting`, or `mixed`, by the kind of
 * its top-level AST nodes only (design doc §9.1). Never descends into children: a variable-only
 * looking partial may still hide a mixin body, but a nested rule inside a top-level `@media`
 * doesn't change anything the top-level `@media` node itself hasn't already decided.
 */
export function classifyPartial(root: Root, file: string): PartialClassificationResult {
  let firstDefinition:
    | { readonly line: number | undefined; readonly column: number | undefined; readonly syntax: string }
    | undefined;
  let firstEmitting:
    | { readonly line: number | undefined; readonly column: number | undefined; readonly syntax: string }
    | undefined;

  for (const node of root.nodes) {
    const { category, syntax } = categorize(node);
    if (category === 'neutral') continue;
    const position = nodeStart(node);
    if (category === 'definition') {
      firstDefinition ??= { ...position, syntax };
    } else {
      firstEmitting ??= { ...position, syntax };
    }
  }

  if (firstDefinition !== undefined && firstEmitting !== undefined) {
    // Anchor at whichever category's first node appears later in the file (the "intruder").
    const definitionLine = firstDefinition.line ?? 0;
    const emittingLine = firstEmitting.line ?? 0;
    const mixedAt = emittingLine >= definitionLine ? firstEmitting : firstDefinition;
    return { file, classification: 'mixed', mixedAt };
  }
  if (firstEmitting !== undefined) {
    return { file, classification: 'style-emitting' };
  }
  return { file, classification: 'definition-only' };
}

/** Converts a `PartialClassificationResult` to a `Diagnostic`; only 'mixed' results produce one. */
export function partialClassificationToDiagnostic(result: PartialClassificationResult): Diagnostic | undefined {
  if (result.classification !== 'mixed' || result.mixedAt === undefined) return undefined;
  const { line, column } = result.mixedAt;
  return {
    file: result.file,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    syntax: 'mixed partial',
    milestone: 'never',
    message: 'partial contains both definitions and style-emitting rules',
    hint: 'Split the file into a definition-only partial and a style-emitting partial.',
  };
}
