import { readFileSync } from 'node:fs';
import functionsListPath from 'css-functions-list';
import valueParser from 'postcss-value-parser';
import {
  COLOR_MODULE_FUNCTIONS,
  CSS_MATH_FUNCTIONS,
  FILTER_SHAPED_COLOR_FUNCTIONS,
  GLOBAL_COLOR_FUNCTIONS,
  GLOBAL_MATH_FUNCTIONS,
  MATH_MODULE_FUNCTIONS,
  OTHER_GLOBAL_ALIASES,
  RGB_HSL_FUNCTIONS,
} from './sass-builtin-functions.ts';
import type { SubsetAction, SubsetFinding } from './subset.ts';

const CSS_FUNCTION_NAMES: ReadonlySet<string> = new Set(
  JSON.parse(readFileSync(functionsListPath, 'utf8')) as string[],
);

const VARIABLE_REFERENCE = /^\$[\w-]+$/u;
const NAMESPACED_VARIABLE = /^[\w-]+\.\$[\w-]+$/u;
const NUMBER_LITERAL = /^[\d.]+%?$/u;

/** Something with postcss's `positionInside` (a `Declaration`, `AtRule`, or `Rule`). */
export interface PositionedNode {
  positionInside(index: number): { readonly line: number; readonly column: number };
}

export interface ValueCheckOptions {
  readonly file: string;
  readonly node: PositionedNode;
  /** Offset of the raw string (passed to `checkValue`) within `node`'s own stringified text. */
  readonly baseOffset: number;
  readonly namespaces: NamespaceMap;
}

export type ResolvedNamespace =
  | { readonly kind: 'math' }
  | { readonly kind: 'color' }
  | { readonly kind: 'other-sass'; readonly module: string }
  | { readonly kind: 'user' };

/** Maps a file's `@use` aliases (module namespace prefixes) to what they resolve to. */
export type NamespaceMap = ReadonlyMap<string, ResolvedNamespace>;

export interface InterpolationSpan {
  /** Index of `#` (start of `#{`) within the raw string. */
  readonly start: number;
  /** Index right after the closing `}`. */
  readonly end: number;
  /** Interpolation body, without the surrounding `#{`/`}`. */
  readonly body: string;
}

/**
 * Scans a raw (un-parsed) string for `#{...}` interpolation spans, brace-counting to find
 * each matching `}`. Must run before postcss-value-parser touches the string: value-parser
 * splits expressions inside interpolation (e.g. `#{$a + $b}`) across multiple word tokens,
 * so interpolation can only be reliably detected on the original text.
 */
export function findInterpolationSpans(raw: string): InterpolationSpan[] {
  const spans: InterpolationSpan[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('#{', i);
    if (start === -1) break;
    let depth = 1;
    let j = start + 2;
    while (j < raw.length && depth > 0) {
      if (raw[j] === '{') depth++;
      else if (raw[j] === '}') depth--;
      j++;
    }
    // Unterminated interpolation (depth never reached 0): treat the rest of the string as the body.
    const end = depth === 0 ? j : raw.length;
    const body = raw.slice(start + 2, depth === 0 ? end - 1 : end);
    spans.push({ start, end, body });
    i = end;
  }
  return spans;
}

/** Replaces each interpolation span with underscores of the same length, so index math survives. */
export function maskInterpolationSpans(raw: string, spans: readonly InterpolationSpan[]): string {
  let result = raw;
  for (const span of spans) {
    result = result.slice(0, span.start) + '_'.repeat(span.end - span.start) + result.slice(span.end);
  }
  return result;
}

function isSingleVariableBody(body: string): boolean {
  return VARIABLE_REFERENCE.test(body.trim());
}

function interpolationFindingsForSpans(
  spans: readonly InterpolationSpan[],
  options: ValueCheckOptions,
): SubsetFinding[] {
  return spans.map((span) => {
    const position = options.node.positionInside(options.baseOffset + span.start);
    const action: SubsetAction = isSingleVariableBody(span.body)
      ? { kind: 'convert', stage: 'interpolation' }
      : {
          kind: 'unsupported',
          milestone: 'never',
          hint: 'Interpolation containing an expression has no dialect equivalent; pre-compute the value or restructure the code so the interpolation body is a single variable.',
        };
    return {
      file: options.file,
      line: position.line,
      column: position.column,
      syntax: isSingleVariableBody(span.body) ? 'interpolation' : 'interpolation containing an expression',
      action,
    };
  });
}

/** Runs only interpolation detection on a raw string (used for custom property values, which are otherwise literal). */
export function checkInterpolationOnly(raw: string, options: ValueCheckOptions): SubsetFinding[] {
  return interpolationFindingsForSpans(findInterpolationSpans(raw), options);
}

function isArithmeticWord(word: string): boolean {
  if (word === '+' || word === '-' || word === '*' || word === '%') return true;
  // `*` can never start a valid CSS literal, so any word led by it is Sass arithmetic (e.g. `*2` from `$a *2`).
  if (word.startsWith('*')) return true;
  // A leading `-`/`+` followed by a digit is a signed number literal (`-2px`), not an operator.
  // A leading `-`/`+` followed by `$` is unary negation of a variable (`-$a`), which needs `calc()`.
  if ((word.startsWith('-') || word.startsWith('+')) && word.includes('$')) return true;
  // `-` is deliberately excluded here: `$a-1` and `$a-$b` read as identifiers/subtraction that dart-sass
  // itself treats ambiguously without spaces, and hyphenated identifiers (`sans-serif`) must not be flagged.
  if (word.includes('$') && (word.includes('+') || word.includes('*') || word.includes('%'))) return true;
  return false;
}

type WordClassification =
  | { readonly kind: 'variable' }
  | { readonly kind: 'namespaced-variable' }
  | { readonly kind: 'default' }
  | { readonly kind: 'global' }
  | { readonly kind: 'arithmetic' }
  | { readonly kind: 'plain' };

function classifyWord(word: string): WordClassification {
  if (VARIABLE_REFERENCE.test(word)) return { kind: 'variable' };
  if (NAMESPACED_VARIABLE.test(word)) return { kind: 'namespaced-variable' };
  if (word === '!default') return { kind: 'default' };
  if (word === '!global') return { kind: 'global' };
  if (isArithmeticWord(word)) return { kind: 'arithmetic' };
  return { kind: 'plain' };
}

function isSpace(node: valueParser.Node): boolean {
  return node.type === 'space';
}

/** Finds the nearest non-space sibling in `nodes` starting at `index`, stepping by `step` (+1/-1). */
function nearestNonSpaceSibling(
  nodes: readonly valueParser.Node[],
  index: number,
  step: 1 | -1,
): valueParser.Node | undefined {
  for (let i = index + step; i >= 0 && i < nodes.length; i += step) {
    const node = nodes[i];
    if (node && !isSpace(node)) return node;
  }
  return undefined;
}

/** Whether a division operand (word/function) involves Sass evaluation, making `/` a division that needs `calc()`. */
function isSassEvaluatedOperand(node: valueParser.Node | undefined): boolean {
  if (!node) return false;
  if (node.type === 'word') return node.value.includes('$');
  if (node.type === 'function') return true; // covers both named calls and `(...)` grouping
  return false;
}

interface FunctionArgs {
  readonly nodes: readonly valueParser.Node[];
  readonly nonSpaceNodes: readonly valueParser.Node[];
  readonly topLevelCommaCount: number;
  readonly raw: string;
}

function analyzeArgs(nodes: readonly valueParser.Node[]): FunctionArgs {
  const nonSpaceNodes = nodes.filter((node) => !isSpace(node));
  const topLevelCommaCount = nonSpaceNodes.filter((node) => node.type === 'div' && node.value === ',').length;
  return { nodes, nonSpaceNodes, topLevelCommaCount, raw: valueParser.stringify([...nodes]) };
}

function isNumberLiteralArg(args: FunctionArgs): boolean {
  const nonDivNodes = args.nonSpaceNodes.filter((node) => node.type !== 'div');
  return nonDivNodes.length === 1 && nonDivNodes[0]?.type === 'word' && NUMBER_LITERAL.test(nonDivNodes[0].value);
}

function splitNamespace(name: string): { readonly alias: string; readonly fn: string } | undefined {
  const dotIndex = name.indexOf('.');
  if (dotIndex === -1) return undefined;
  return { alias: name.slice(0, dotIndex), fn: name.slice(dotIndex + 1) };
}

interface FunctionClassification {
  readonly action: SubsetAction;
  readonly syntax: string;
}

function classifyNamespacedFunction(
  writtenName: string,
  alias: string,
  fn: string,
  namespaces: NamespaceMap,
): FunctionClassification {
  const fnLower = fn.toLowerCase();
  const resolved = namespaces.get(alias);
  if (resolved === undefined || resolved.kind === 'user') {
    return {
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'User-defined or unresolved namespaced function; rewrite the call result manually.',
      },
      syntax: writtenName,
    };
  }
  if (resolved.kind === 'math') {
    return MATH_MODULE_FUNCTIONS.has(fnLower)
      ? { action: { kind: 'convert', stage: 'expressions' }, syntax: `math.${fnLower}` }
      : {
          action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS math function counterpart.' },
          syntax: `math.${fnLower}`,
        };
  }
  if (resolved.kind === 'color') {
    return COLOR_MODULE_FUNCTIONS.has(fnLower)
      ? { action: { kind: 'convert', stage: 'colors' }, syntax: `color.${fnLower}` }
      : {
          action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS color function counterpart.' },
          syntax: `color.${fnLower}`,
        };
  }
  return {
    action: {
      kind: 'unsupported',
      milestone: 'never',
      hint: `No CSS counterpart for \`sass:${resolved.module}\` functions; rewrite manually.`,
    },
    syntax: `${resolved.module}.${fnLower}`,
  };
}

function classifyFunction(
  node: valueParser.FunctionNode,
  namespaces: NamespaceMap,
): FunctionClassification | undefined {
  const writtenName = node.value;
  if (writtenName === '') {
    // Plain `(...)` grouping — no finding of its own; operators inside are flagged by the word/div rules.
    return undefined;
  }
  const namespaced = splitNamespace(writtenName);
  if (namespaced) {
    return classifyNamespacedFunction(writtenName, namespaced.alias, namespaced.fn, namespaces);
  }

  const nameLower = writtenName.toLowerCase();
  const args = analyzeArgs(node.nodes);

  if (RGB_HSL_FUNCTIONS.has(nameLower)) {
    if (args.topLevelCommaCount === 1) {
      return { action: { kind: 'convert', stage: 'colors' }, syntax: `${nameLower}($color, $alpha)` };
    }
    return undefined; // 3/4-arg form is plain CSS; descend to catch issues in the args
  }
  if (nameLower === 'saturate') {
    if (args.topLevelCommaCount === 1) {
      return { action: { kind: 'convert', stage: 'colors' }, syntax: 'saturate' };
    }
    return undefined; // single-argument CSS filter form
  }
  if (FILTER_SHAPED_COLOR_FUNCTIONS.has(nameLower)) {
    if (isNumberLiteralArg(args)) return undefined; // plain CSS filter
    return {
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: `The CSS filter form and the Sass color function \`${nameLower}\` are indistinguishable here without evaluating the argument.`,
      },
      syntax: nameLower,
    };
  }
  if (nameLower === 'alpha') {
    if (args.raw.includes('=')) return undefined; // legacy IE filter syntax
    return {
      action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS counterpart; rewrite manually.' },
      syntax: 'alpha',
    };
  }
  if (nameLower === 'if') {
    return {
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'Sass `if()` has no safe CSS equivalent here; rewrite manually.',
      },
      syntax: 'if()',
    };
  }
  if (nameLower === 'mix') {
    return { action: { kind: 'convert', stage: 'colors' }, syntax: 'mix' };
  }
  if (GLOBAL_COLOR_FUNCTIONS.has(nameLower)) {
    return { action: { kind: 'convert', stage: 'colors' }, syntax: nameLower };
  }
  if (GLOBAL_MATH_FUNCTIONS.has(nameLower)) {
    return { action: { kind: 'convert', stage: 'expressions' }, syntax: nameLower };
  }
  if (OTHER_GLOBAL_ALIASES.has(nameLower)) {
    return {
      action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS counterpart; rewrite manually.' },
      syntax: nameLower,
    };
  }
  if (CSS_FUNCTION_NAMES.has(nameLower)) {
    return undefined; // plain CSS function — descend to catch issues in the args
  }
  return {
    action: {
      kind: 'unsupported',
      milestone: 'never',
      hint: 'If this is a plain CSS function, please report it; if it is a Sass function, rewrite it manually.',
    },
    syntax: `unknown function "${writtenName}()"`,
  };
}

function offsetOf(node: valueParser.Node, options: ValueCheckOptions): number {
  return options.baseOffset + node.sourceIndex;
}

function pushWordFinding(
  findings: SubsetFinding[],
  node: valueParser.WordNode,
  options: ValueCheckOptions,
  insideMathFunction: boolean,
): void {
  const classification = classifyWord(node.value);
  if (classification.kind === 'variable' || classification.kind === 'plain') return;
  // Inside `calc()`/`min()`/etc., dart-sass parses the contents as plain CSS math, not
  // SassScript: operators are literal and require no conversion (see CSS_MATH_FUNCTIONS).
  if (classification.kind === 'arithmetic' && insideMathFunction) return;

  const position = options.node.positionInside(offsetOf(node, options));
  const base = { file: options.file, line: position.line, column: position.column };
  if (classification.kind === 'namespaced-variable') {
    findings.push({ ...base, syntax: 'namespaced variable', action: { kind: 'convert', stage: 'modules' } });
  } else if (classification.kind === 'default') {
    findings.push({ ...base, syntax: '!default', action: { kind: 'unsupported', milestone: 'never' } });
  } else if (classification.kind === 'global') {
    findings.push({ ...base, syntax: '!global', action: { kind: 'unsupported', milestone: 'never' } });
  } else {
    findings.push({ ...base, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } });
  }
}

function walkParsedValue(
  nodes: readonly valueParser.Node[],
  options: ValueCheckOptions,
  findings: SubsetFinding[],
  insideMathFunction: boolean,
): void {
  nodes.forEach((node, index) => {
    if (node.type === 'string') return; // literal — do not descend
    if (node.type === 'word') {
      pushWordFinding(findings, node, options, insideMathFunction);
      return;
    }
    if (node.type === 'div') {
      if (node.value !== '/') return; // `,` and `:` are structural, not arithmetic
      if (insideMathFunction) return; // literal division inside calc()/etc.
      const before = nearestNonSpaceSibling(nodes, index, -1);
      const after = nearestNonSpaceSibling(nodes, index, 1);
      if (isSassEvaluatedOperand(before) || isSassEvaluatedOperand(after)) {
        const position = options.node.positionInside(offsetOf(node, options));
        findings.push({
          file: options.file,
          line: position.line,
          column: position.column,
          syntax: 'division',
          action: { kind: 'convert', stage: 'expressions' },
        });
      }
      return;
    }
    if (node.type === 'function') {
      const classification = classifyFunction(node, options.namespaces);
      if (classification) {
        const position = options.node.positionInside(offsetOf(node, options));
        findings.push({
          file: options.file,
          line: position.line,
          column: position.column,
          syntax: classification.syntax,
          action: classification.action,
        });
      }
      // Namespaced calls (`math.div(...)`) are full SassScript, evaluated eagerly by Sass —
      // only a bare, non-namespaced CSS math function name enters "literal math" context.
      const isNamespaced = node.value.includes('.');
      const childInsideMathFunction =
        insideMathFunction || (!isNamespaced && CSS_MATH_FUNCTIONS.has(node.value.toLowerCase()));
      walkParsedValue(node.nodes, options, findings, childInsideMathFunction);
    }
  });
}

/** Full value-level check: interpolation extraction (pass 1), then operator/function classification (pass 2). */
export function checkValue(raw: string, options: ValueCheckOptions): SubsetFinding[] {
  const findings: SubsetFinding[] = [];
  const spans = findInterpolationSpans(raw);
  findings.push(...interpolationFindingsForSpans(spans, options));
  const masked = maskInterpolationSpans(raw, spans);
  const parsed = valueParser(masked);
  walkParsedValue(parsed.nodes, options, findings, false);
  // Pass 1 (interpolation) and pass 2 (everything else) are collected independently, so
  // re-sort by position to restore source order across the two passes.
  return sortByPosition(findings);
}

/** Sorts findings by (line, column), for callers that assemble findings from more than one pass. */
export function sortByPosition(findings: readonly SubsetFinding[]): SubsetFinding[] {
  return [...findings].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
}

/** Finds the substring inside the first balanced `(...)` in `params`, e.g. the argument list of a mixin/include. */
export function extractParenArgs(params: string): { readonly content: string; readonly offset: number } | undefined {
  const open = params.indexOf('(');
  if (open === -1) return undefined;
  let depth = 1;
  let i = open + 1;
  while (i < params.length && depth > 0) {
    if (params[i] === '(') depth++;
    else if (params[i] === ')') depth--;
    i++;
  }
  if (depth !== 0) return undefined; // unbalanced — caller should not attempt to value-check it
  return { content: params.slice(open + 1, i - 1), offset: open + 1 };
}
