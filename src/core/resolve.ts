import { dirname } from 'node:path';
import type { ResolverFactory } from 'oxc-resolver';
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
  for (const char of params) {
    if (quote !== undefined) {
      current += char;
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

/** basename with an underscore prefix (Sass partial naming convention). Only ever applied to the basename, not the directory part. */
function partialOf(base: string): string {
  return `_${base}`;
}

/** Splits a specifier into its directory prefix (including any trailing `/`) and basename. */
function splitDirAndBase(specifier: string): { readonly dir: string; readonly base: string } {
  const lastSlash = specifier.lastIndexOf('/');
  if (lastSlash === -1) return { dir: '', base: specifier };
  return { dir: specifier.slice(0, lastSlash + 1), base: specifier.slice(lastSlash + 1) };
}

/**
 * Expands a Sass module specifier into the file names Sass would try, in resolution order
 * (design doc §5.1, "candidate 展開"). The underscore of the partial-file convention is only
 * ever added to the basename, never to a directory segment.
 *
 * - No extension: tier 1 tries `name.scss` / `_name.scss` / `name.css` / `_name.css`; tier 2
 *   (only tried if tier 1 matches nothing) tries `name/index.scss` / `name/_index.scss`.
 * - `.scss`/`.css` extension given: only the exact path and its partial variant are tried.
 */
export function expandSassCandidates(specifier: string): {
  readonly fileCandidates: string[];
  readonly indexCandidates: string[];
} {
  const { dir, base } = splitDirAndBase(specifier);

  if (base.endsWith('.scss') || base.endsWith('.css')) {
    return { fileCandidates: [specifier, `${dir}${partialOf(base)}`], indexCandidates: [] };
  }

  return {
    fileCandidates: [
      `${dir}${base}.scss`,
      `${dir}${partialOf(base)}.scss`,
      `${dir}${base}.css`,
      `${dir}${partialOf(base)}.css`,
    ],
    indexCandidates: [`${dir}${base}/index.scss`, `${dir}${base}/_index.scss`],
  };
}

export type ResolveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous'; readonly candidates: string[] };

/** Resolves every candidate in `candidates` from `dir`, returning the distinct paths that exist. */
function resolveTier(dir: string, candidates: readonly string[], resolver: ResolverFactory): string[] {
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const result = resolver.sync(dir, `./${candidate}`);
    if (result.path !== undefined) resolved.add(result.path);
  }
  return [...resolved];
}

/**
 * Resolves a Sass module specifier relative to `importer` (Sass is relative-first; load paths
 * are not supported in M0). Candidates are tried tier by tier ({@link expandSassCandidates}):
 * once a tier matches at least one file, later tiers are not tried. Multiple distinct matches
 * within a tier are `ambiguous` (fail-closed), mirroring Sass's own behavior for e.g. `theme.scss`
 * and `_theme.scss` coexisting.
 */
export function resolveSassSpecifier(importer: string, specifier: string, resolver: ResolverFactory): ResolveResult {
  const { fileCandidates, indexCandidates } = expandSassCandidates(specifier);
  const dir = dirname(importer);

  const tier1 = resolveTier(dir, fileCandidates, resolver);
  if (tier1.length === 1) return { ok: true, path: tier1[0] };
  if (tier1.length > 1) return { ok: false, reason: 'ambiguous', candidates: tier1 };

  if (indexCandidates.length > 0) {
    const tier2 = resolveTier(dir, indexCandidates, resolver);
    if (tier2.length === 1) return { ok: true, path: tier2[0] };
    if (tier2.length > 1) return { ok: false, reason: 'ambiguous', candidates: tier2 };
  }

  return { ok: false, reason: 'not-found', candidates: [...fileCandidates, ...indexCandidates] };
}
