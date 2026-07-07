import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Root } from 'postcss';
import { collectFiles } from '../core/collect.ts';
import { formatDiagnostics, type Diagnostic } from '../core/diagnostic.ts';
import { parseScss, stringifyScss } from '../core/parse.ts';
import { writeFilesAtomically, type FileWrite } from '../core/write.ts';
import type { CliIo } from '../io.ts';
import type { StageInfo } from '../stages.ts';
import { transformAtStatements } from '../stages/at-statements.ts';
import { transformComments } from '../stages/comments.ts';
import type { StageTransform } from '../stages/types.ts';

export interface ConvertCommandOptions {
  readonly stage: StageInfo;
  readonly patterns: readonly string[];
  readonly exclude?: readonly string[];
  readonly loadPaths?: readonly string[];
  readonly alias?: Record<string, readonly string[]>;
}

/**
 * Stages with an implemented transform (design doc §13.2 Step 10 and later). A stage listed in
 * `STAGES` (see `../stages.ts`) but absent here is recognized by the CLI but not yet convertible.
 */
const TRANSFORMS: ReadonlyMap<string, StageTransform> = new Map([
  ['comments', transformComments],
  ['at-statements', transformAtStatements],
]);

/** Mirrors the milestone-specific wording `runConvert` used before stage transforms existed. */
function notImplementedMessage(stage: StageInfo): string {
  return stage.milestone === 'M0'
    ? `scss-codemod convert ${stage.name}: not implemented yet.`
    : `scss-codemod convert ${stage.name}: planned for ${stage.milestone}.`;
}

function toRel(file: string, cwd: string): string {
  return relative(cwd, file);
}

function relativizeDiagnostic(diagnostic: Diagnostic, cwd: string): Diagnostic {
  return { ...diagnostic, file: toRel(diagnostic.file, cwd) };
}

interface ParsedFile {
  readonly original: string;
  readonly root: Root;
}

/**
 * Runs `convert <stage>` (design doc §7 "書き込みの挙動", §8.3 "precondition 検査とエラー処理"):
 * collects the target files, parses and transforms each one in memory, and only writes back once
 * every file in the run has succeeded. A single failure — a parse error or a transform
 * diagnostic, on any file — blocks writing for the whole run, including files that converted
 * cleanly (project-level atomicity). Diagnostic collection itself continues through every file
 * before the run is judged to have failed.
 */
export async function runConvertCommand(options: ConvertCommandOptions, io: CliIo): Promise<number> {
  const cwd = realpathSync(io.cwd ?? process.cwd());

  const transform = TRANSFORMS.get(options.stage.name);
  if (!transform) {
    io.stderr.write(`${notImplementedMessage(options.stage)}\n`);
    return 1;
  }

  const files = await collectFiles(options.patterns, { cwd, exclude: options.exclude });
  if (files.length === 0) {
    io.stderr.write('scss-codemod convert: no files matched the given patterns\n');
    return 2;
  }

  const diagnostics: Diagnostic[] = [];
  const logs: Diagnostic[] = [];
  const parsedFiles = new Map<string, ParsedFile>();

  const sources = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  for (const [index, file] of files.entries()) {
    const source = sources[index] ?? '';
    const result = parseScss(source, file);
    if (!result.ok) {
      diagnostics.push(result.diagnostic);
      continue;
    }
    parsedFiles.set(file, { original: source, root: result.root });
  }

  for (const [file, { root }] of parsedFiles) {
    const result = transform(root, file);
    diagnostics.push(...result.diagnostics);
    logs.push(...result.logs);
  }

  if (diagnostics.length > 0) {
    io.stderr.write(formatDiagnostics(diagnostics.map((diagnostic) => relativizeDiagnostic(diagnostic, cwd))));
    return 1;
  }

  const writes: FileWrite[] = [];
  let unchangedCount = 0;
  for (const [file, { original, root }] of parsedFiles) {
    const output = stringifyScss(root);
    if (output === original) {
      unchangedCount += 1;
      continue;
    }
    writes.push({ path: file, content: output });
  }

  const writeResult = await writeFilesAtomically(writes);
  if (!writeResult.ok) {
    io.stderr.write(formatDiagnostics(writeResult.diagnostics.map((d) => relativizeDiagnostic(d, cwd))));
    return 1;
  }

  if (logs.length > 0) {
    io.stderr.write(formatDiagnostics(logs.map((log) => relativizeDiagnostic(log, cwd))));
  }

  io.stdout.write(`${options.stage.name}: converted ${parsedFiles.size} files (${unchangedCount} unchanged)\n`);
  return 0;
}
