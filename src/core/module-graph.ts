import { realpathSync } from 'node:fs';
import type { Root } from 'postcss';
import type { Diagnostic } from './diagnostic.ts';
import { createSassResolver, extractImportStatements, resolveSassSpecifier, type ImportStatement } from './resolve.ts';

export interface ResolvedImport {
  readonly statement: ImportStatement;
  readonly resolvedPath: string;
}

export interface ModuleGraph {
  /** importer (absolute path, a key of the `parsedFiles` given to `buildModuleGraph`) → resolved imports within the target set. */
  readonly edges: ReadonlyMap<string, readonly ResolvedImport[]>;
}

const KIND_TO_SYNTAX: Record<ImportStatement['kind'], string> = {
  use: '@use',
  forward: '@forward',
  import: '@import',
};

function diagnosticFor(statement: ImportStatement): Diagnostic {
  return {
    file: statement.file,
    line: statement.line,
    column: statement.column,
    syntax: KIND_TO_SYNTAX[statement.kind],
    message: `cannot resolve import "${statement.specifier}"`,
  };
}

/**
 * Builds a map from each file's real path to its key in `parsedFiles`, so that oxc-resolver's
 * realpath-canonicalized results (design doc §5.1) can be matched back against the target set
 * regardless of symlinks (e.g. macOS's `/tmp` → `/private/tmp`).
 */
function buildRealPathIndex(parsedFiles: ReadonlyMap<string, Root>): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of parsedFiles.keys()) {
    index.set(realpathSync(file), file);
  }
  return index;
}

export interface BuildModuleGraphOptions {
  /** Directories to resolve specifiers from when relative and node_modules resolution find nothing (dart-sass loadPaths equivalent, `--load-path`). */
  readonly loadPaths?: readonly string[];
}

/**
 * Extracts `@use`/`@forward`/Sass `@import` statements from every file in `parsedFiles` and
 * resolves them into a module graph (design doc §5.1). `parsedFiles` is the target file set:
 * I/O and parsing are the caller's responsibility (Step 8's `analyze`).
 *
 * A specifier that resolves outside `parsedFiles` (glob range or `node_modules`) is silently
 * ignored — no edge, no diagnostic. A specifier that fails to resolve produces a `Diagnostic`
 * (fail-closed).
 */
export function buildModuleGraph(
  parsedFiles: ReadonlyMap<string, Root>,
  options: BuildModuleGraphOptions = {},
): {
  graph: ModuleGraph;
  diagnostics: Diagnostic[];
} {
  const resolver = createSassResolver();
  const loadPaths = options.loadPaths ?? [];
  const realPathIndex = buildRealPathIndex(parsedFiles);
  const diagnostics: Diagnostic[] = [];
  const edges = new Map<string, ResolvedImport[]>();

  for (const [importer, root] of parsedFiles) {
    const statements = extractImportStatements(root, importer);
    const resolvedImports: ResolvedImport[] = [];

    for (const statement of statements) {
      const result = resolveSassSpecifier(importer, statement.specifier, resolver, loadPaths);
      if (!result.ok) {
        diagnostics.push(diagnosticFor(statement));
        continue;
      }
      const canonical = realPathIndex.get(result.path);
      if (canonical === undefined) continue; // Out of the target set: glob range or node_modules.
      resolvedImports.push({ statement, resolvedPath: canonical });
    }

    if (resolvedImports.length > 0) edges.set(importer, resolvedImports);
  }

  return { graph: { edges }, diagnostics };
}

/** Files that import `file` within the graph (design doc §9.1, consumer identification). */
export function importersOf(graph: ModuleGraph, file: string): string[] {
  const importers: string[] = [];
  for (const [importer, resolvedImports] of graph.edges) {
    if (resolvedImports.some((resolved) => resolved.resolvedPath === file)) {
      importers.push(importer);
    }
  }
  return importers;
}
