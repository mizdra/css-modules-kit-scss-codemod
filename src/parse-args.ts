import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

type OptionSpec = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

export interface ParsedCommandArgs {
  readonly ok: true;
  readonly values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  readonly positionals: string[];
}

export interface ParseCommandArgsError {
  readonly ok: false;
  readonly message: string;
}

/** Parses a command's remaining argv with a fixed option set, rejecting unknown options. */
export function parseCommandArgs(
  commandName: string,
  args: string[],
  options: OptionSpec,
): ParsedCommandArgs | ParseCommandArgsError {
  try {
    const { values, positionals } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { ok: true, values, positionals };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `scss-codemod ${commandName}: ${reason}` };
  }
}

export interface ParsedAliasArgs {
  readonly ok: true;
  readonly alias: Record<string, string[]>;
}

export interface ParseAliasArgsError {
  readonly ok: false;
  readonly message: string;
}

/**
 * Parses repeatable `--alias <from=to>` values into a bundler-style alias map (enhanced-resolve
 * semantics; see `createSassResolver`). Each value is split on its first `=`; `to` is resolved
 * against `cwd`. Repeating the same `from` accumulates targets into that key's array.
 */
export function parseAliasArgs(values: readonly string[], cwd: string): ParsedAliasArgs | ParseAliasArgsError {
  const alias: Record<string, string[]> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const from = separator === -1 ? '' : value.slice(0, separator);
    const to = separator === -1 ? '' : value.slice(separator + 1);
    if (from === '' || to === '') {
      return { ok: false, message: `scss-codemod: invalid --alias "${value}" (expected <from>=<to>)` };
    }
    (alias[from] ??= []).push(resolve(cwd, to));
  }
  return { ok: true, alias };
}
