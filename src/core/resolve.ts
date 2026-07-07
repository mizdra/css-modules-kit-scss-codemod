import { dirname, posix } from 'node:path';
import { ResolverFactory } from 'oxc-resolver';
import type { AtRule, Root } from 'postcss';
import { isPlainCssImport } from './classify.ts';

export interface ImportStatement {
  readonly kind: 'use' | 'forward' | 'import';
  readonly specifier: string;
  readonly file: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

interface NodeStart {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

function atRuleStart(atrule: AtRule): NodeStart {
  const start = atrule.source?.start;
  return { line: start?.line, column: start?.column };
}

const QUOTED_SPECIFIER = /^(['"])((?:\\.|(?!\1).)*)\1/u;

/** The content of the first quoted string in `text`, or `undefined` if it doesn't start with one. */
function firstQuotedSpecifier(text: string): string | undefined {
  const match = QUOTED_SPECIFIER.exec(text.trim());
  return match?.[2];
}

/** Sass built-in modules (`sass:*`) and `pkg:` specifiers have no file to resolve; skip them. */
function isSkippedSpecifier(specifier: string): boolean {
  return specifier.startsWith('sass:') || specifier.startsWith('pkg:');
}

/** Splits `@import`'s comma-separated params into individual entries, respecting quoted strings. */
function splitImportEntries(params: string): string[] {
  const entries: string[] = [];
  let current = '';
  let quote: string | undefined;
  let escaped = false;
  for (const char of params) {
    if (quote !== undefined) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      entries.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last !== '') entries.push(last);
  return entries;
}

function extractUseOrForward(atrule: AtRule, file: string, kind: 'use' | 'forward'): ImportStatement | undefined {
  const specifier = firstQuotedSpecifier(atrule.params);
  if (specifier === undefined || isSkippedSpecifier(specifier)) return undefined;
  const { line, column } = atRuleStart(atrule);
  return { kind, specifier, file, line, column };
}

function extractImport(atrule: AtRule, file: string): ImportStatement[] {
  const { line, column } = atRuleStart(atrule);
  const statements: ImportStatement[] = [];
  for (const entry of splitImportEntries(atrule.params)) {
    if (isPlainCssImport(entry)) continue;
    const specifier = firstQuotedSpecifier(entry);
    if (specifier === undefined || isSkippedSpecifier(specifier)) continue;
    statements.push({ kind: 'import', specifier, file, line, column });
  }
  return statements;
}

/**
 * Extracts `@use`/`@forward`/Sass `@import` statements from a parsed root (design doc §5.1).
 * Plain-CSS `@import` forms, `sass:*` built-in modules, and `pkg:` specifiers are skipped since
 * they have no file for the module graph to resolve. A comma-separated `@import` becomes one
 * `ImportStatement` per specifier.
 */
export function extractImportStatements(root: Root, file: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  root.walkAtRules((atrule) => {
    if (atrule.name === 'use' || atrule.name === 'forward') {
      const statement = extractUseOrForward(atrule, file, atrule.name);
      if (statement) statements.push(statement);
      return;
    }
    if (atrule.name === 'import') {
      statements.push(...extractImport(atrule, file));
    }
  });
  return statements;
}

/**
 * The resolver requests to try for a Sass specifier, in order — a port of sass-loader's
 * `getPossibleRequests` (utils.js at webpack/sass-loader@0e793b0), minus the legacy
 * `@import`-only `.import` convention. Only the partial `_` prefix is expanded here; the
 * extension-less form and directory references are delegated to the resolver's `extensions`
 * and `mainFiles` options ({@link createSassResolver}). The underscore is only ever added to
 * the basename, never to a directory segment.
 */
export function possibleRequestsOf(specifier: string): string[] {
  // Sass compiles `.css`-suffixed specifiers as references to plain CSS files: no partial variant.
  if (posix.extname(specifier).toLowerCase() === '.css') return [specifier];

  const dir = posix.dirname(specifier);
  const prefix = dir === '.' ? '' : `${dir}/`;
  const base = posix.basename(specifier);
  return [...new Set([`${prefix}_${base}`, `${prefix}${base}`])];
}

export type ResolveResult = { readonly ok: true; readonly path: string } | { readonly ok: false };

export interface CreateSassResolverOptions {
  /**
   * Bundler-style alias map (enhanced-resolve semantics: keys are prefix matches, a
   * `$`-suffixed key matches exactly), reproducing the user's vite/webpack `resolve.alias`.
   */
  readonly alias?: Record<string, readonly string[]>;
}

/**
 * Creates the resolver shared by all Sass specifier resolution, configured like sass-loader's
 * enhanced-resolve resolver (utils.js at webpack/sass-loader@0e793b0), minus `.sass` (out of
 * scope): extension-less specifiers, directory references (`_index`/`index`), relative-first
 * ordering for bare specifiers, and package entries (`sass`/`style` fields and export
 * conditions) are all handled by the resolver. `restrictions` rejects resolutions to
 * non-Sass-loadable files, e.g. a package `main` pointing at `.js` (fail-closed).
 */
export function createSassResolver(options: CreateSassResolverOptions = {}): ResolverFactory {
  return new ResolverFactory({
    extensions: ['.scss', '.css'],
    mainFiles: ['_index', 'index'],
    preferRelative: true,
    modules: ['node_modules'],
    mainFields: ['sass', 'style', 'main'],
    conditionNames: ['sass', 'style'],
    restrictions: [{ regex: '\\.s?css$' }],
    ...(options.alias !== undefined
      ? { alias: Object.fromEntries(Object.entries(options.alias).map(([from, to]) => [from, [...to]])) }
      : {}),
  });
}

/**
 * Resolves a Sass module specifier by trying {@link possibleRequestsOf} in order, first match
 * wins: the resolver's `preferRelative` covers importer-relative then node_modules resolution
 * (matching the bundler resolution order verified for vite and turbopack, design doc §14), and
 * each `loadPaths` directory is tried afterwards (dart-sass loadPaths equivalent). Ambiguity
 * (e.g. `theme.scss` and `_theme.scss` coexisting) is not detected: such projects fail to build
 * with sass itself, so they are outside the working-codebase assumption (design doc §3, principle
 * 4) — the partial request comes first, like sass-loader.
 */
export function resolveSassSpecifier(
  importer: string,
  specifier: string,
  resolver: ResolverFactory,
  loadPaths: readonly string[] = [],
): ResolveResult {
  const requests = possibleRequestsOf(specifier);
  const importerDir = dirname(importer);

  for (const request of requests) {
    const result = resolver.sync(importerDir, request);
    if (result.path !== undefined) return { ok: true, path: result.path };
  }

  for (const loadPath of loadPaths) {
    for (const request of requests) {
      // The `./` prefix forces relative resolution: a load path lookup must not fall through
      // to node_modules again.
      const result = resolver.sync(loadPath, `./${request}`);
      if (result.path !== undefined) return { ok: true, path: result.path };
    }
  }

  return { ok: false };
}
