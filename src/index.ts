import type { Writable } from 'node:stream';
import { parseCommandArgs } from './parse-args.ts';
import { findStage, STAGE_NAMES } from './stages.ts';
import { USAGE } from './usage.ts';

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
}

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

function runAnalyze(args: string[], io: CliIo): number {
  const parsed = parseCommandArgs('analyze', args, {
    exclude: { type: 'string', multiple: true },
    json: { type: 'boolean' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod analyze: missing <patterns...>');
  }
  return notImplemented(io, 'The "analyze" command is not implemented yet.');
}

function runConvert(args: string[], io: CliIo): number {
  const parsed = parseCommandArgs('convert', args, {
    exclude: { type: 'string', multiple: true },
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

  if (stageInfo.milestone === 'M0') {
    return notImplemented(io, `scss-codemod convert ${stage}: not implemented yet.`);
  }
  return notImplemented(io, `scss-codemod convert ${stage}: planned for ${stageInfo.milestone}.`);
}

function runVerify(args: string[], io: CliIo): number {
  const parsed = parseCommandArgs('verify', args, {
    exclude: { type: 'string', multiple: true },
    against: { type: 'string' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod verify: missing <patterns...>');
  }
  return notImplemented(io, 'scss-codemod verify: planned for M1.');
}

function runTodo(args: string[], io: CliIo): number {
  const parsed = parseCommandArgs('todo', args, {
    exclude: { type: 'string', multiple: true },
    json: { type: 'boolean' },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  if (parsed.positionals.length === 0) {
    return usageError(io, 'scss-codemod todo: missing <patterns...>');
  }
  return notImplemented(io, 'The "todo" command is not implemented yet.');
}

// `runCli` is async as part of its public contract; upcoming stages will perform async I/O.
// oxlint-disable-next-line typescript/require-await
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
      return runAnalyze(rest, io);
    case 'convert':
      return runConvert(rest, io);
    case 'verify':
      return runVerify(rest, io);
    case 'todo':
      return runTodo(rest, io);
    default:
      return usageError(io, `scss-codemod: unknown command "${command}"`);
  }
}
