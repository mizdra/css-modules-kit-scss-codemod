import { resolve } from 'node:path';
import { runAnalyzeCommand } from './commands/analyze.ts';
import { runConvertCommand } from './commands/convert.ts';
import { runTodoCommand } from './commands/todo.ts';
import type { CliIo } from './io.ts';
import { parseAliasArgs, parseCommandArgs } from './parse-args.ts';
import { findStage, STAGE_NAMES } from './stages.ts';
import { USAGE } from './usage.ts';

export type { CliIo } from './io.ts';

function help(io: CliIo): number {
  io.stdout.write(USAGE);
  return 0;
}

function usageError(io: CliIo, message: string): number {
  io.stderr.write(`${message}\n\n${USAGE}`);
  return 2;
}

function notImplemented(io: CliIo, message: string): number {
  io.stderr.write(`${message}\n`);
  return 1;
}

/** Narrows a parsed multi-value option (`string | boolean | (string | boolean)[] | undefined`) down to its strings. */
function toStringArray(value: string | boolean | (string | boolean)[] | undefined): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string');
}

async function runAnalyze(args: string[], io: CliIo): Promise<number> {
  const parsed = parseCommandArgs('analyze', args, {
    'exclude': { type: 'string', multiple: true },
    'load-path': { type: 'string', multiple: true },
    'alias': { type: 'string', multiple: true },
    'json': { type: 'boolean' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod analyze: missing <patterns...>');
  }

  const cwd = io.cwd ?? process.cwd();
  const aliasResult = parseAliasArgs(toStringArray(parsed.values.alias), cwd);
  if (!aliasResult.ok) return usageError(io, aliasResult.message);
  const loadPaths = toStringArray(parsed.values['load-path']).map((loadPath) => resolve(cwd, loadPath));

  return runAnalyzeCommand(
    {
      patterns: parsed.positionals,
      exclude: toStringArray(parsed.values.exclude),
      loadPaths,
      alias: aliasResult.alias,
      json: parsed.values.json === true,
    },
    io,
  );
}

async function runConvert(args: string[], io: CliIo): Promise<number> {
  const parsed = parseCommandArgs('convert', args, {
    'exclude': { type: 'string', multiple: true },
    'load-path': { type: 'string', multiple: true },
    'alias': { type: 'string', multiple: true },
  });
  if (!parsed.ok) return usageError(io, parsed.message);

  const [stage, ...patterns] = parsed.positionals;
  if (stage === undefined) {
    return usageError(io, 'scss-codemod convert: missing <stage>');
  }

  const stageInfo = findStage(stage);
  if (!stageInfo) {
    return usageError(io, `scss-codemod convert: unknown stage "${stage}"\nValid stages: ${STAGE_NAMES.join(', ')}`);
  }

  if (patterns.length === 0) {
    return usageError(io, 'scss-codemod convert: missing <patterns...>');
  }

  const cwd = io.cwd ?? process.cwd();
  const aliasResult = parseAliasArgs(toStringArray(parsed.values.alias), cwd);
  if (!aliasResult.ok) return usageError(io, aliasResult.message);
  const loadPaths = toStringArray(parsed.values['load-path']).map((loadPath) => resolve(cwd, loadPath));

  return runConvertCommand(
    {
      stage: stageInfo,
      patterns,
      exclude: toStringArray(parsed.values.exclude),
      loadPaths,
      alias: aliasResult.alias,
    },
    io,
  );
}

function runVerify(args: string[], io: CliIo): number {
  const parsed = parseCommandArgs('verify', args, {
    'exclude': { type: 'string', multiple: true },
    'load-path': { type: 'string', multiple: true },
    'alias': { type: 'string', multiple: true },
    'against': { type: 'string' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod verify: missing <patterns...>');
  }
  return notImplemented(io, 'scss-codemod verify: planned for M1.');
}

async function runTodo(args: string[], io: CliIo): Promise<number> {
  const parsed = parseCommandArgs('todo', args, {
    'exclude': { type: 'string', multiple: true },
    'load-path': { type: 'string', multiple: true },
    'alias': { type: 'string', multiple: true },
    'json': { type: 'boolean' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod todo: missing <patterns...>');
  }

  const cwd = io.cwd ?? process.cwd();
  const aliasResult = parseAliasArgs(toStringArray(parsed.values.alias), cwd);
  if (!aliasResult.ok) return usageError(io, aliasResult.message);
  const loadPaths = toStringArray(parsed.values['load-path']).map((loadPath) => resolve(cwd, loadPath));

  return runTodoCommand(
    {
      patterns: parsed.positionals,
      exclude: toStringArray(parsed.values.exclude),
      loadPaths,
      alias: aliasResult.alias,
      json: parsed.values.json === true,
    },
    io,
  );
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    return help(io);
  }

  if (argv.length === 0) {
    return usageError(io, 'scss-codemod: missing command');
  }

  const [command, ...rest] = argv;
  switch (command) {
    case 'analyze':
      return await runAnalyze(rest, io);
    case 'convert':
      return await runConvert(rest, io);
    case 'verify':
      return runVerify(rest, io);
    case 'todo':
      return await runTodo(rest, io);
    default:
      return usageError(io, `scss-codemod: unknown command "${command}"`);
  }
}
