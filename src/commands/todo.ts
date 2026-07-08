import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { classifySyntax, syntaxFindingToDiagnostic } from '../core/classify.ts';
import { collectFiles } from '../core/collect.ts';
import { formatMilestone, type Diagnostic } from '../core/diagnostic.ts';
import { parseScss } from '../core/parse.ts';
import { classifyPartial, isPartial, partialClassificationToDiagnostic } from '../core/partial.ts';
import type { CliIo } from '../io.ts';

export interface TodoCommandOptions {
  readonly patterns: readonly string[];
  readonly exclude?: readonly string[];
  readonly loadPaths?: readonly string[];
  readonly alias?: Record<string, readonly string[]>;
  readonly json?: boolean;
}

/** Manual-rewrite hint for a syntax name, used when `classifySyntax`/`classifyPartial` didn't already attach one (design doc §11). */
const CONTROL_FLOW_HINT = 'Unroll the rules this control-flow construct generates and write them out explicitly.';
const DEFAULT_FLAG_HINT =
  'Inline the value actually used at this declaration (the declared value, unless a `@use ... with` configuration overrides it).';
const GLOBAL_FLAG_HINT = 'Move the declaration to the top level.';
const USE_WITH_HINT =
  'Hardcode the configured values at the use sites, then use a plain `@use` (without `with (...)`).';
const MAP_LIST_HINT = 'Expand the map/list into individual `$var` declarations.';
const FUNCTION_HINT = 'Pre-compute the result of the call and inline it, or re-express the function as a mixin.';
const GENERIC_HINT = 'Pre-compute the value and write it directly in place of this construct.';

const DEFAULT_HINTS_BY_SYNTAX: ReadonlyMap<string, string> = new Map([
  ['@if', CONTROL_FLOW_HINT],
  ['@else', CONTROL_FLOW_HINT],
  ['@each', CONTROL_FLOW_HINT],
  ['@for', CONTROL_FLOW_HINT],
  ['@while', CONTROL_FLOW_HINT],
  ['!default', DEFAULT_FLAG_HINT],
  ['!global', GLOBAL_FLAG_HINT],
  ['@use ... with (configuration)', USE_WITH_HINT],
  ['map/list value', MAP_LIST_HINT],
  ['@function', FUNCTION_HINT],
  ['@return', FUNCTION_HINT],
]);

/** Fills in a syntax-name-based default hint (design doc §11) for diagnostics classify left hint-less. */
function applyDefaultHint(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.hint !== undefined) return diagnostic;
  const hint = (diagnostic.syntax !== undefined && DEFAULT_HINTS_BY_SYNTAX.get(diagnostic.syntax)) || GENERIC_HINT;
  return { ...diagnostic, hint };
}

function sortByPosition(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
}

/** Collects a single file's todo diagnostics: unsupported syntax, mixed partial, or a parse failure. */
function collectFileTodos(source: string, file: string): Diagnostic[] {
  const result = parseScss(source, file);
  if (!result.ok) return [result.diagnostic];

  const todos: Diagnostic[] = [];
  for (const finding of classifySyntax(result.root, file)) {
    if (finding.action.kind !== 'unsupported') continue;
    todos.push(applyDefaultHint(syntaxFindingToDiagnostic(finding)));
  }
  if (isPartial(file)) {
    const partialDiagnostic = partialClassificationToDiagnostic(classifyPartial(result.root, file));
    if (partialDiagnostic) todos.push(partialDiagnostic);
  }
  return sortByPosition(todos);
}

function toRel(file: string, cwd: string): string {
  return relative(cwd, file);
}

function byRelPath(cwd: string): (a: string, b: string) => number {
  return (a, b) => toRel(a, cwd).localeCompare(toRel(b, cwd));
}

function relativizeDiagnostic(diagnostic: Diagnostic, cwd: string): Diagnostic {
  return { ...diagnostic, file: toRel(diagnostic.file, cwd) };
}

function formatTodoItem(diagnostic: Diagnostic): string {
  const location =
    diagnostic.line !== undefined && diagnostic.column !== undefined
      ? `**L${diagnostic.line}:${diagnostic.column}**`
      : `**${diagnostic.file}**`;
  const syntaxPart = diagnostic.syntax !== undefined ? ` \`${diagnostic.syntax}\`` : '';
  const milestonePart = diagnostic.milestone !== undefined ? ` (${formatMilestone(diagnostic.milestone)})` : '';
  const hintLine = diagnostic.hint !== undefined ? `\n  hint: ${diagnostic.hint}` : '';
  return `- ${location}${syntaxPart}${milestonePart} — ${diagnostic.message}${hintLine}`;
}

/**
 * Renders the todo prompt as markdown meant to be handed straight to a human or a coding agent
 * (design doc §11): a summary, one section per affected file, and a closing instruction to
 * re-run `convert`/`verify` once the manual fixes above are made.
 */
function buildMarkdownReport(
  todosByFile: ReadonlyMap<string, readonly Diagnostic[]>,
  cwd: string,
  patterns: readonly string[],
): string {
  const files = [...todosByFile.keys()].sort(byRelPath(cwd));
  const totalCount = files.reduce((sum, file) => sum + (todosByFile.get(file)?.length ?? 0), 0);
  if (totalCount === 0) return 'No manual work found.\n';

  const patternArgs = patterns.join(' ');
  const lines: string[] = [
    '# Manual work required',
    '',
    `${totalCount} item${totalCount === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'} need manual conversion. scss-codemod only converts syntax on its whitelist and never auto-converts anything outside it. Fix each item below by hand.`,
  ];
  for (const file of files) {
    lines.push('', `## ${toRel(file, cwd)}`, '');
    for (const diagnostic of todosByFile.get(file) ?? []) {
      lines.push(formatTodoItem(diagnostic));
    }
  }
  lines.push(
    '',
    `Once fixed, re-run \`scss-codemod convert <stage> ${patternArgs}\` so the remaining syntax converts automatically. Finally, run \`scss-codemod verify ${patternArgs}\` to confirm the migration.`,
  );
  return `${lines.join('\n')}\n`;
}

function buildJsonReport(todosByFile: ReadonlyMap<string, readonly Diagnostic[]>, cwd: string): string {
  const files = [...todosByFile.keys()].sort(byRelPath(cwd));
  const todos = files.flatMap((file) =>
    (todosByFile.get(file) ?? []).map((diagnostic) => relativizeDiagnostic(diagnostic, cwd)),
  );
  const summary = { todoCount: todos.length, fileCount: files.length };
  return `${JSON.stringify({ todos, summary })}\n`;
}

/**
 * Runs `todo` (design doc §11, §13.2 Step 15): finds the manual work a whitelist-based codemod
 * cannot do for itself — syntax `classifySyntax` rejects, mixed partials, and files that fail to
 * parse — and reports it as either a markdown prompt (default) or `--json`. Reports only; it never
 * fixes anything.
 */
export async function runTodoCommand(options: TodoCommandOptions, io: CliIo): Promise<number> {
  const cwd = realpathSync(io.cwd ?? process.cwd());
  const files = await collectFiles(options.patterns, { cwd, exclude: options.exclude });

  if (files.length === 0) {
    io.stderr.write('scss-codemod todo: no files matched the given patterns\n');
    return 2;
  }

  const todosByFile = new Map<string, Diagnostic[]>();
  const sources = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  for (const [index, file] of files.entries()) {
    const source = sources[index] ?? '';
    const todos = collectFileTodos(source, file);
    if (todos.length > 0) todosByFile.set(file, todos);
  }

  const todoCount = [...todosByFile.values()].reduce((sum, list) => sum + list.length, 0);
  io.stdout.write(
    options.json ? buildJsonReport(todosByFile, cwd) : buildMarkdownReport(todosByFile, cwd, options.patterns),
  );
  return todoCount === 0 ? 0 : 1;
}
