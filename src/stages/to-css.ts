import { realpathSync } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConvertCommandOptions } from '../commands/convert.ts';
import { collectFiles } from '../core/collect.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostic.ts';
import { validateDialect } from '../core/dialect-validator.ts';
import { writeFilesAtomically, type FileWrite } from '../core/write.ts';
import type { CliIo } from '../io.ts';

const TS_JS_PATTERNS = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];

const SCSS_EXTENSION = '.scss';

function toRel(file: string, cwd: string): string {
  return path.relative(cwd, file);
}

function relativizeDiagnostic(diagnostic: Diagnostic, cwd: string): Diagnostic {
  return { ...diagnostic, file: toRel(diagnostic.file, cwd) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `.module.scss` → `.module.css`, `_x.scss` → `x.css` (design doc §8.1 stage 8 `to-css`). */
function computeNewPath(oldPath: string): string {
  const dir = path.dirname(oldPath);
  const base = path.basename(oldPath);
  const unprefixed = base.startsWith('_') ? base.slice(1) : base;
  const newBase = unprefixed.endsWith(SCSS_EXTENSION)
    ? `${unprefixed.slice(0, -SCSS_EXTENSION.length)}.css`
    : unprefixed;
  return path.join(dir, newBase);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** A collision between two target files renaming to the same new path (e.g. `_x.scss` and `x.scss` both present). */
function collisionDiagnostics(renameMap: ReadonlyMap<string, string>, cwd: string): Diagnostic[] {
  const byNewPath = new Map<string, string[]>();
  for (const [oldPath, newPath] of renameMap) {
    const group = byNewPath.get(newPath);
    if (group) group.push(oldPath);
    else byNewPath.set(newPath, [oldPath]);
  }

  const diagnostics: Diagnostic[] = [];
  for (const [newPath, oldPaths] of byNewPath) {
    if (oldPaths.length < 2) continue;
    const sortedRel = [...oldPaths].map((oldPath) => toRel(oldPath, cwd)).sort();
    for (const oldPath of oldPaths) {
      diagnostics.push({
        file: oldPath,
        syntax: 'to-css rename collision',
        message: `Multiple target files would rename to "${toRel(newPath, cwd)}": ${sortedRel.join(', ')}.`,
      });
    }
  }
  return diagnostics;
}

/** A rename target that already exists on disk as a real file outside the rename plan. */
async function existingTargetDiagnostics(renameMap: ReadonlyMap<string, string>, cwd: string): Promise<Diagnostic[]> {
  const firstSourceByTarget = new Map<string, string>();
  for (const [oldPath, newPath] of renameMap) {
    if (!firstSourceByTarget.has(newPath)) firstSourceByTarget.set(newPath, oldPath);
  }

  const diagnostics: Diagnostic[] = [];
  for (const [newPath, oldPath] of firstSourceByTarget) {
    // Serial by design: bounded by the target file count (mirrors core/write.ts's serial phases).
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (await pathExists(newPath)) {
      diagnostics.push({
        file: oldPath,
        syntax: 'to-css rename target exists',
        message: `Rename target "${toRel(newPath, cwd)}" already exists on disk.`,
      });
    }
  }
  return diagnostics;
}

interface ScssSpecifierMatch {
  readonly quote: "'" | '"';
  /** Raw text between the quotes, exactly as written (including any `?query` suffix). */
  readonly specifier: string;
  /** Offset of the first character of `specifier` in the source (just past the opening quote). */
  readonly start: number;
  /** Offset just past the last character of `specifier` in the source (just before the closing quote). */
  readonly end: number;
}

/** Matches a single- or double-quoted string literal, mirroring `dialect-validator.ts`'s `extractQuotedSpecifier`. */
const QUOTED_STRING_REGEX = /(['"])((?:\\.|(?!\1).)*)\1/gu;

/**
 * Scans raw TS/JS source text for quoted string literals whose path portion ends in `.scss`
 * (optionally followed by a `?query` suffix, e.g. `foo.scss?inline`) (design doc §8.1 stage 8
 * `to-css`, §13.2 Step 14).
 *
 * This is intentionally a text-based regex scan, not a real JS/TS parse: it may match inside
 * comments or non-import string literals. The only false-positive risk is "a quoted string that
 * happens to end in `.scss`", which is low-cost: worst case is a diagnostic asking a human to fix
 * an import that isn't real, or a rewrite of a string that isn't semantically an import — both
 * acceptable under the design doc's fail-closed philosophy for the unresolvable case (§3,
 * principle 1), and harmless for the resolvable case since the rewrite is a straight substring
 * swap of the specifier text only.
 */
function findScssSpecifiers(source: string): ScssSpecifierMatch[] {
  const matches: ScssSpecifierMatch[] = [];
  for (const match of source.matchAll(QUOTED_STRING_REGEX)) {
    const quote = match[1];
    const specifier = match[2];
    if (quote !== "'" && quote !== '"') continue;
    if (specifier === undefined) continue;
    const queryIndex = specifier.indexOf('?');
    const pathPart = queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
    if (!pathPart.endsWith(SCSS_EXTENSION)) continue;

    const start = (match.index ?? 0) + 1;
    matches.push({ quote, specifier, start, end: start + specifier.length });
  }
  return matches;
}

function splitSpecifier(specifier: string): { readonly pathPart: string; readonly query: string } {
  const queryIndex = specifier.indexOf('?');
  return queryIndex === -1
    ? { pathPart: specifier, query: '' }
    : { pathPart: specifier.slice(0, queryIndex), query: specifier.slice(queryIndex) };
}

/** 1-based line/column of `offset` within `source` (raw JS/TS text has no AST here to read a position from). */
function offsetToPosition(source: string, offset: number): { readonly line: number; readonly column: number } {
  let line = 1;
  let lastNewlineIndex = -1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lastNewlineIndex = i;
    }
  }
  return { line, column: offset - lastNewlineIndex };
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Scans one TS/JS file's specifiers, resolving relative `.scss` specifiers against `renameMap`
 * (the scss rename plan) and rewriting the ones that land on a renamed target. A relative
 * specifier resolving to a `.scss` file outside `renameMap` (out of the target glob's scope) is
 * left untouched — no diagnostic (design doc §3, principle 4: files outside the target range are
 * not this tool's concern). A non-relative (bare/alias) specifier is fail-closed: it cannot be
 * resolved to a file, so it is reported as a diagnostic instead of silently left to break once
 * `sass` is removed from the build.
 */
function scanAndRewriteSpecifiers(
  file: string,
  source: string,
  renameMap: ReadonlyMap<string, string>,
): { readonly rewritten?: string; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const replacements: Replacement[] = [];

  for (const match of findScssSpecifiers(source)) {
    const { pathPart, query } = splitSpecifier(match.specifier);

    if (pathPart.startsWith('./') || pathPart.startsWith('../')) {
      const resolvedOld = path.resolve(path.dirname(file), pathPart);
      const newTarget = renameMap.get(resolvedOld);
      if (newTarget === undefined) continue; // out of target scope — leave as-is, no diagnostic
      const dirPrefix = pathPart.slice(0, pathPart.length - path.basename(pathPart).length);
      replacements.push({
        start: match.start,
        end: match.end,
        text: `${dirPrefix}${path.basename(newTarget)}${query}`,
      });
      continue;
    }

    const position = offsetToPosition(source, match.start);
    diagnostics.push({
      file,
      line: position.line,
      column: position.column,
      syntax: 'unresolvable .scss import specifier',
      message: `Import specifier "${match.specifier}" is not a relative path, so it cannot be resolved to a renamed file.`,
      hint: 'The "to-css" stage only rewrites relative (`./`, `../`) specifiers. Once `sass` is removed from the build (the next step after to-css), this import will fail to resolve — update it manually to the new `.css` filename.',
    });
  }

  if (diagnostics.length > 0) return { diagnostics };
  if (replacements.length === 0) return { diagnostics: [] };

  replacements.sort((a, b) => b.start - a.start);
  let rewritten = source;
  for (const replacement of replacements) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  return { rewritten, diagnostics: [] };
}

/**
 * Reverses already-applied renames and TS/JS rewrites, best-effort, when a later rename in the
 * same run fails partway through (mirrors `core/write.ts`'s commit-phase rollback structure, but
 * over filesystem renames rather than content replacement). A rollback failure is appended as an
 * additional diagnostic rather than thrown, matching `writeFilesAtomically`'s convention.
 */
async function rollback(
  completedRenames: readonly (readonly [string, string])[],
  originalTsJsContents: ReadonlyMap<string, string>,
  rewrittenFiles: ReadonlySet<string>,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  for (const [oldPath, newPath] of completedRenames) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await rename(newPath, oldPath);
    } catch (error) {
      diagnostics.push({
        file: newPath,
        message: `failed to roll back rename to "${oldPath}": ${errorMessage(error)}`,
      });
    }
  }

  for (const file of rewrittenFiles) {
    const original = originalTsJsContents.get(file);
    if (original === undefined) continue;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await writeFile(file, original, 'utf8');
    } catch (error) {
      diagnostics.push({ file, message: `failed to restore original content: ${errorMessage(error)}` });
    }
  }

  return diagnostics;
}

/**
 * Runs `convert to-css` (design doc §8.1 stage 8, §8.3 precondition, §13.2 Step 14): the final
 * Phase 2 stage. Unlike other stages (`../stages/types.ts`'s `StageTransform`, one AST in → one
 * AST out), `to-css` operates across two file kinds (`.scss` files being renamed, and `.ts`/`.js`
 * files whose import specifiers reference them) and performs filesystem renames rather than
 * content-only edits, so it is orchestrated directly here instead of going through `TRANSFORMS`
 * in `../commands/convert.ts`.
 *
 * Steps, matching the design doc's symmetric precondition/transform relationship (§8.3): collect
 * target `.scss` files → compute the rename plan → reject on rename collisions or pre-existing
 * rename targets → validate the post-rename dialect precondition (§13.2 Step 13) → scan every
 * TS/JS file in the tree for `.scss` import specifiers and rewrite the ones that resolve to a
 * renamed target (bare/alias specifiers are fail-closed diagnostics) → write TS/JS changes, then
 * rename the `.scss` files, rolling both back if a rename fails partway through. Every check
 * runs to completion before any diagnostic causes an early return, and a single diagnostic at any
 * point blocks every write for the whole run (project-level atomicity, §8.3).
 */
export async function runToCssStage(options: ConvertCommandOptions, io: CliIo): Promise<number> {
  const cwd = realpathSync(io.cwd ?? process.cwd());

  const scssFiles = await collectFiles(options.patterns, { cwd, exclude: options.exclude });
  if (scssFiles.length === 0) {
    io.stderr.write('scss-codemod convert to-css: no files matched the given patterns\n');
    return 2;
  }

  const renameMap = new Map<string, string>(scssFiles.map((file) => [file, computeNewPath(file)]));

  const collisionDiags = [
    ...collisionDiagnostics(renameMap, cwd),
    ...(await existingTargetDiagnostics(renameMap, cwd)),
  ];
  if (collisionDiags.length > 0) {
    io.stderr.write(formatDiagnostics(collisionDiags.map((d) => relativizeDiagnostic(d, cwd))));
    return 1;
  }

  const scssSources = new Map<string, string>();
  for (const file of scssFiles) {
    // Serial by design (mirrors core/write.ts): bounded by the target file count.
    // oxlint-disable-next-line eslint/no-await-in-loop
    scssSources.set(file, await readFile(file, 'utf8'));
  }

  const reverseRenameMap = new Map([...renameMap.entries()].map(([oldPath, newPath]) => [newPath, oldPath]));
  const dialectFiles = new Map(
    [...renameMap.entries()].map(([oldPath, newPath]) => [newPath, scssSources.get(oldPath) ?? '']),
  );
  const { diagnostics: dialectDiagnostics } = await validateDialect(dialectFiles);
  if (dialectDiagnostics.length > 0) {
    const mapped = dialectDiagnostics.map((d) => ({ ...d, file: reverseRenameMap.get(d.file) ?? d.file }));
    io.stderr.write(formatDiagnostics(mapped.map((d) => relativizeDiagnostic(d, cwd))));
    return 1;
  }

  const tsJsFiles = await collectFiles(TS_JS_PATTERNS, { cwd, exclude: options.exclude });
  const tsJsSources = new Map<string, string>();
  for (const file of tsJsFiles) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    tsJsSources.set(file, await readFile(file, 'utf8'));
  }

  const specifierDiagnostics: Diagnostic[] = [];
  const rewrittenContents = new Map<string, string>();
  for (const [file, source] of tsJsSources) {
    const { rewritten, diagnostics } = scanAndRewriteSpecifiers(file, source, renameMap);
    specifierDiagnostics.push(...diagnostics);
    if (rewritten !== undefined) rewrittenContents.set(file, rewritten);
  }

  if (specifierDiagnostics.length > 0) {
    io.stderr.write(formatDiagnostics(specifierDiagnostics.map((d) => relativizeDiagnostic(d, cwd))));
    return 1;
  }

  const tsJsWrites: FileWrite[] = [...rewrittenContents.entries()].map(([file, content]) => ({ path: file, content }));
  const writeResult = await writeFilesAtomically(tsJsWrites);
  if (!writeResult.ok) {
    io.stderr.write(formatDiagnostics(writeResult.diagnostics.map((d) => relativizeDiagnostic(d, cwd))));
    return 1;
  }

  const completedRenames: (readonly [string, string])[] = [];
  for (const oldPath of [...renameMap.keys()].sort()) {
    const newPath = renameMap.get(oldPath);
    if (newPath === undefined) continue;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await rename(oldPath, newPath);
      completedRenames.push([oldPath, newPath]);
    } catch (error) {
      const failureDiagnostic: Diagnostic = { file: oldPath, message: errorMessage(error) };
      // oxlint-disable-next-line eslint/no-await-in-loop
      const rollbackDiagnostics = await rollback(completedRenames, tsJsSources, new Set(rewrittenContents.keys()));
      io.stderr.write(
        formatDiagnostics([failureDiagnostic, ...rollbackDiagnostics].map((d) => relativizeDiagnostic(d, cwd))),
      );
      return 1;
    }
  }

  const renameCount = renameMap.size;
  const rewriteCount = rewrittenContents.size;
  io.stdout.write(
    `to-css: renamed ${renameCount} file${renameCount === 1 ? '' : 's'}, rewrote imports in ${rewriteCount} file${
      rewriteCount === 1 ? '' : 's'
    }.\n\n` +
      'Next steps: remove `sass` from your build and switch to the PostCSS plugin chain\n' +
      'postcss-mixins -> postcss-simple-vars -> postcss-nested (this order is required).\n' +
      'If you need to support older browsers, add postcss-preset-env after postcss-nested.\n' +
      'After switching, run `scss-codemod verify`.\n',
  );
  return 0;
}
