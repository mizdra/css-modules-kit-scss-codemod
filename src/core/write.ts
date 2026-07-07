import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic } from './diagnostic.ts';

/** One target file's replacement (design doc §7, §13.2 Step 9). */
export interface FileWrite {
  /** Absolute path of the file to replace. The file must already exist. */
  readonly path: string;
  readonly content: string;
}

export type WriteFilesResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

let tempFileCounter = 0;

/** Builds a temp file path colocated with `target`'s directory, named `.<basename>.<pid>-<n>.tmp`. */
function tempPathFor(target: string): string {
  tempFileCounter += 1;
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `.${base}.${process.pid}-${tempFileCounter}.tmp`);
}

function toDiagnostic(file: string, error: unknown): Diagnostic {
  return { file, message: error instanceof Error ? error.message : String(error) };
}

/** Best-effort deletion of leftover temp files; a deletion failure is silently ignored. */
async function removeTempFiles(tempPaths: readonly string[]): Promise<void> {
  for (const tempPath of tempPaths) {
    try {
      // Serial by design; small, bounded batches (M0; no parallelism).
      // oxlint-disable-next-line eslint/no-await-in-loop
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup: nothing more to do if this fails.
    }
  }
}

/**
 * Replaces each target file's content atomically, all-or-nothing (design doc §7, §13.2 Step 9):
 * either every write in `writes` lands, or the filesystem is left as it was before the call.
 *
 * Two phases:
 * 1. **Prepare**: read and hold each target's original content (for rollback), then stage the
 *    new content into a sibling temp file (same directory as the target). Any failure here
 *    (e.g. a target doesn't exist, or its directory isn't writable) leaves every target file
 *    untouched; the temp files created so far are removed.
 * 2. **Commit**: `rename` each temp file over its target, in order. If a rename fails partway
 *    through, the already-committed targets are rolled back to their original content
 *    (best-effort: a rollback failure is reported as an additional diagnostic rather than
 *    silently dropped). Leftover temp files are always removed.
 *
 * Files are processed serially (M0; no parallelism). A no-op (`writes` empty) succeeds without
 * touching the filesystem.
 */
export async function writeFilesAtomically(writes: readonly FileWrite[]): Promise<WriteFilesResult> {
  if (writes.length === 0) return { ok: true };

  const originals: string[] = [];
  const tempPaths: string[] = [];

  // Phase 1: prepare — hold original contents and stage new content into temp files.
  for (const write of writes) {
    let original: string;
    try {
      // Serial by design (M0; see doc comment above).
      // oxlint-disable-next-line eslint/no-await-in-loop
      original = await readFile(write.path, 'utf8');
    } catch (error) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await removeTempFiles(tempPaths);
      return { ok: false, diagnostics: [toDiagnostic(write.path, error)] };
    }
    originals.push(original);

    const tempPath = tempPathFor(write.path);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await writeFile(tempPath, write.content, 'utf8');
    } catch (error) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await removeTempFiles(tempPaths);
      return { ok: false, diagnostics: [toDiagnostic(write.path, error)] };
    }
    tempPaths.push(tempPath);
  }

  // Phase 2: commit — rename each temp file over its target, in order.
  for (let i = 0; i < writes.length; i++) {
    const write = writes[i];
    const tempPath = tempPaths[i];
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await rename(tempPath, write.path);
    } catch (error) {
      const diagnostics: Diagnostic[] = [toDiagnostic(write.path, error)];
      // Roll back targets already committed (indices before `i`), best-effort.
      for (let j = 0; j < i; j++) {
        const rolledBackWrite = writes[j];
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop
          await writeFile(rolledBackWrite.path, originals[j], 'utf8');
        } catch (rollbackError) {
          diagnostics.push(toDiagnostic(rolledBackWrite.path, rollbackError));
        }
      }
      // Remove the temp file that failed to rename plus any not yet attempted.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await removeTempFiles(tempPaths.slice(i));
      return { ok: false, diagnostics };
    }
  }

  return { ok: true };
}
