import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CollectOptions {
  readonly cwd: string;
  readonly exclude?: readonly string[];
}

/** Collects files matching the given glob patterns. Always excludes node_modules. */
export async function collectFiles(patterns: readonly string[], options: CollectOptions): Promise<string[]> {
  const exclude = ['**/node_modules/**', ...(options.exclude ?? [])];

  const files: string[] = [];
  for await (const entry of glob(patterns, {
    cwd: options.cwd,
    exclude,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      files.push(resolve(entry.parentPath, entry.name));
    }
  }

  return [...new Set(files)].sort();
}
