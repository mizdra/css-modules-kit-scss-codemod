import { parseArgs } from "node:util";

type OptionSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

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
