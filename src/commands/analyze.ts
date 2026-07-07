import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Root } from 'postcss';
import { classifySyntax, syntaxFindingToDiagnostic, type SyntaxFinding } from '../core/classify.ts';
import { collectFiles } from '../core/collect.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostic.ts';
import { buildModuleGraph, type ModuleGraph } from '../core/module-graph.ts';
import { parseScss } from '../core/parse.ts';
import {
  classifyPartial,
  isPartial,
  partialClassificationToDiagnostic,
  type PartialClassification,
  type PartialClassificationResult,
} from '../core/partial.ts';
import { checkSassCompiles, type SassCompileCheck } from '../core/sass-compile.ts';
import type { CliIo } from '../io.ts';
import { STAGES } from '../stages.ts';

export interface AnalyzeCommandOptions {
  readonly patterns: readonly string[];
  readonly exclude?: readonly string[];
  readonly loadPaths?: readonly string[];
  readonly alias?: Record<string, readonly string[]>;
  readonly json?: boolean;
}

/** Display label for an import statement's kind, e.g. `'use'` → `'@use'`. */
const IMPORT_KIND_LABEL: Record<'use' | 'forward' | 'import', string> = {
  use: '@use',
  forward: '@forward',
  import: '@import',
};

interface ReportContext {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly rootCount: number;
  readonly partialCount: number;
  readonly parsedFiles: ReadonlyMap<string, Root>;
  readonly diagnostics: readonly Diagnostic[];
  readonly convertFindingsByFile: ReadonlyMap<string, readonly SyntaxFinding[]>;
  readonly partialClassifications: ReadonlyMap<string, PartialClassificationResult>;
  readonly compileChecks: ReadonlyMap<string, SassCompileCheck>;
  readonly graph: ModuleGraph;
}

/**
 * Runs the full analyze pipeline (design doc §7, §13.2 Step 8): collect → parse → classify
 * syntax → build the module graph → classify partials → check dart-sass compilation. Static,
 * whitelist-based checks run first so their diagnostics don't depend on dart-sass being
 * installed correctly; the dart-sass compile check (design doc §3, principle 4) runs last.
 */
export async function runAnalyzeCommand(options: AnalyzeCommandOptions, io: CliIo): Promise<number> {
  const cwd = realpathSync(io.cwd ?? process.cwd());
  const files = await collectFiles(options.patterns, { cwd, exclude: options.exclude });

  if (files.length === 0) {
    io.stderr.write('scss-codemod analyze: no files matched the given patterns\n');
    return 2;
  }

  const diagnostics: Diagnostic[] = [];
  const parsedFiles = new Map<string, Root>();
  const convertFindingsByFile = new Map<string, SyntaxFinding[]>();

  const sources = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  for (const [index, file] of files.entries()) {
    const source = sources[index] ?? '';
    const result = parseScss(source, file);
    if (!result.ok) {
      diagnostics.push(result.diagnostic);
      continue;
    }
    parsedFiles.set(file, result.root);

    const convertFindings: SyntaxFinding[] = [];
    for (const finding of classifySyntax(result.root, file)) {
      if (finding.action.kind === 'convert') {
        convertFindings.push(finding);
      } else {
        diagnostics.push(syntaxFindingToDiagnostic(finding));
      }
    }
    convertFindingsByFile.set(file, convertFindings);
  }

  const { graph, diagnostics: moduleDiagnostics } = buildModuleGraph(parsedFiles, {
    loadPaths: options.loadPaths,
    alias: options.alias,
  });
  diagnostics.push(...moduleDiagnostics);

  const partialClassifications = new Map<string, PartialClassificationResult>();
  for (const [file, root] of parsedFiles) {
    if (!isPartial(file)) continue;
    const result = classifyPartial(root, file);
    partialClassifications.set(file, result);
    const diagnostic = partialClassificationToDiagnostic(result);
    if (diagnostic) diagnostics.push(diagnostic);
  }

  const roots = [...parsedFiles.keys()].filter((file) => !isPartial(file));
  const compileResults = await checkSassCompiles(roots, {
    loadPaths: options.loadPaths,
    alias: options.alias,
  });
  const compileChecks = new Map(compileResults.map((check) => [check.file, check] as const));
  for (const check of compileResults) {
    if (!check.ok && check.diagnostic) diagnostics.push(check.diagnostic);
  }

  const partialCount = files.filter((file) => isPartial(file)).length;
  const context: ReportContext = {
    cwd,
    files,
    rootCount: files.length - partialCount,
    partialCount,
    parsedFiles,
    diagnostics,
    convertFindingsByFile,
    partialClassifications,
    compileChecks,
    graph,
  };

  io.stdout.write(options.json ? buildJsonReport(context) : buildHumanReport(context));
  return diagnostics.length === 0 ? 0 : 1;
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

function buildUncompilableSection(ctx: ReportContext): string {
  const uncompilable = [...ctx.compileChecks.values()]
    .filter((check) => !check.ok)
    .map((check) => check.file)
    .sort(byRelPath(ctx.cwd));
  if (uncompilable.length === 0) return 'Uncompilable files: none';
  return ['Uncompilable files:', ...uncompilable.map((file) => `  ${toRel(file, ctx.cwd)}`)].join('\n');
}

function buildModuleGraphSection(ctx: ReportContext): string {
  if (ctx.graph.edges.size === 0) return 'Module graph: none';
  const lines = ['Module graph:'];
  const importers = [...ctx.graph.edges.keys()].sort(byRelPath(ctx.cwd));
  for (const importer of importers) {
    lines.push(`  ${toRel(importer, ctx.cwd)}`);
    for (const edge of ctx.graph.edges.get(importer) ?? []) {
      const kind = IMPORT_KIND_LABEL[edge.statement.kind];
      lines.push(`    → ${toRel(edge.resolvedPath, ctx.cwd)} (${kind} "${edge.statement.specifier}")`);
    }
  }
  return lines.join('\n');
}

function buildPartialsSection(ctx: ReportContext): string | undefined {
  if (ctx.partialClassifications.size === 0) return undefined;
  const lines = ['Partials:'];
  const files = [...ctx.partialClassifications.keys()].sort(byRelPath(ctx.cwd));
  for (const file of files) {
    const result = ctx.partialClassifications.get(file);
    if (!result) continue;
    const suffix = result.classification === 'mixed' ? ' (error)' : '';
    lines.push(`  ${toRel(file, ctx.cwd)}: ${result.classification}${suffix}`);
  }
  return lines.join('\n');
}

/** Files where at least one convert finding is attributed to `stageName` (design doc §8.1). */
function filesConvertibleByStage(ctx: ReportContext, stageName: string): string[] {
  const files: string[] = [];
  for (const [file, findings] of ctx.convertFindingsByFile) {
    const applies = findings.some((finding) => finding.action.kind === 'convert' && finding.action.stage === stageName);
    if (applies) files.push(file);
  }
  return files.sort(byRelPath(ctx.cwd));
}

function buildStageApplicabilitySection(ctx: ReportContext): string | undefined {
  const lines = ['Stage applicability:'];
  let hasStage = false;
  for (const stage of STAGES) {
    const files = filesConvertibleByStage(ctx, stage.name);
    if (files.length === 0) continue;
    hasStage = true;
    const relFiles = files.map((file) => toRel(file, ctx.cwd));
    lines.push(
      `  ${stage.name} (${stage.safety}, ${stage.milestone}): ${relFiles.length} files — ${relFiles.join(', ')}`,
    );
  }
  return hasStage ? lines.join('\n') : undefined;
}

function buildProblemsSection(ctx: ReportContext): string | undefined {
  if (ctx.diagnostics.length === 0) return undefined;
  const relativized = ctx.diagnostics.map((diagnostic) => relativizeDiagnostic(diagnostic, ctx.cwd));
  return `Problems:\n${formatDiagnostics(relativized).trimEnd()}`;
}

function buildSummaryLine(ctx: ReportContext): string {
  const errorCount = ctx.diagnostics.length;
  if (errorCount === 0) return 'Summary: no errors';
  return `Summary: ${errorCount} error${errorCount === 1 ? '' : 's'}`;
}

function buildHumanReport(ctx: ReportContext): string {
  const sections = [
    `Analyzed ${ctx.files.length} files (${ctx.rootCount} roots, ${ctx.partialCount} partials)`,
    buildUncompilableSection(ctx),
    buildModuleGraphSection(ctx),
    buildPartialsSection(ctx),
    buildStageApplicabilitySection(ctx),
    buildProblemsSection(ctx),
    buildSummaryLine(ctx),
  ].filter((section): section is string => section !== undefined);
  return `${sections.join('\n\n')}\n`;
}

interface JsonImportEntry {
  readonly kind: 'use' | 'forward' | 'import';
  readonly specifier: string;
  readonly resolvedPath: string;
  readonly line?: number;
  readonly column?: number;
}

interface JsonConvertibleEntry {
  readonly stage: string;
  readonly syntax: string;
  readonly line?: number;
  readonly column?: number;
}

interface JsonFileEntry {
  readonly path: string;
  readonly role: 'root' | 'partial';
  readonly compiles?: boolean;
  readonly partialClassification?: PartialClassification;
  readonly imports?: readonly JsonImportEntry[];
  readonly convertible?: readonly JsonConvertibleEntry[];
}

function buildJsonImports(file: string, ctx: ReportContext): JsonImportEntry[] {
  return (ctx.graph.edges.get(file) ?? []).map((edge) => ({
    kind: edge.statement.kind,
    specifier: edge.statement.specifier,
    resolvedPath: toRel(edge.resolvedPath, ctx.cwd),
    ...(edge.statement.line !== undefined ? { line: edge.statement.line } : {}),
    ...(edge.statement.column !== undefined ? { column: edge.statement.column } : {}),
  }));
}

function buildJsonConvertible(file: string, ctx: ReportContext): JsonConvertibleEntry[] {
  return (ctx.convertFindingsByFile.get(file) ?? []).flatMap((finding) => {
    if (finding.action.kind !== 'convert') return [];
    return [
      {
        stage: finding.action.stage,
        syntax: finding.syntax,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.column !== undefined ? { column: finding.column } : {}),
      },
    ];
  });
}

function buildJsonFileEntry(file: string, ctx: ReportContext): JsonFileEntry {
  const role: 'root' | 'partial' = isPartial(file) ? 'partial' : 'root';
  const path = toRel(file, ctx.cwd);
  if (!ctx.parsedFiles.has(file)) return { path, role };

  const compiles = role === 'root' ? ctx.compileChecks.get(file)?.ok : undefined;
  const partialClassification = role === 'partial' ? ctx.partialClassifications.get(file)?.classification : undefined;

  return {
    path,
    role,
    ...(compiles !== undefined ? { compiles } : {}),
    ...(partialClassification !== undefined ? { partialClassification } : {}),
    imports: buildJsonImports(file, ctx),
    convertible: buildJsonConvertible(file, ctx),
  };
}

function buildJsonReport(ctx: ReportContext): string {
  const files = ctx.files.map((file) => buildJsonFileEntry(file, ctx));
  const diagnostics = ctx.diagnostics.map((diagnostic) => relativizeDiagnostic(diagnostic, ctx.cwd));

  const stages: Record<string, string[]> = {};
  for (const stage of STAGES) {
    const relFiles = filesConvertibleByStage(ctx, stage.name).map((file) => toRel(file, ctx.cwd));
    if (relFiles.length > 0) stages[stage.name] = relFiles;
  }

  const summary = {
    fileCount: ctx.files.length,
    rootCount: ctx.rootCount,
    partialCount: ctx.partialCount,
    errorCount: ctx.diagnostics.length,
    stages,
  };

  return `${JSON.stringify({ files, diagnostics, summary })}\n`;
}
