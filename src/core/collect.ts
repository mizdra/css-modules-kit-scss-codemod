import { glob } from "tinyglobby";

export interface CollectOptions {
  readonly cwd: string;
  readonly exclude?: readonly string[];
}

/** Collects files matching the given glob patterns. Always excludes node_modules. */
export async function collectFiles(
  patterns: readonly string[],
  options: CollectOptions,
): Promise<string[]> {
  const ignore = ["**/node_modules/**", ...(options.exclude ?? [])];

  const files = await glob(patterns, {
    cwd: options.cwd,
    ignore,
    absolute: true,
    expandDirectories: false,
  });

  return [...new Set(files)].sort();
}
