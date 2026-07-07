import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ResolverFactory } from 'oxc-resolver';
import { compileAsync, Exception, Logger } from 'sass';
import type { Diagnostic } from './diagnostic.ts';
import { createSassResolver, resolveSassSpecifier } from './resolve.ts';

export interface SassCompileOptions {
  /** Directories to resolve specifiers from when relative and node_modules resolution find nothing (dart-sass loadPaths equivalent, `--load-path`). */
  readonly loadPaths?: readonly string[];
  /** Bundler-style alias map (`--alias`, enhanced-resolve semantics; see `CreateSassResolverOptions`). */
  readonly alias?: Record<string, readonly string[]>;
}

export interface SassCompileCheck {
  /** The entry file that was checked. */
  readonly file: string;
  readonly ok: boolean;
  /** Present iff `!ok`. */
  readonly diagnostic?: Diagnostic;
}

/**
 * Builds the `FileImporter` that routes every specifier sass tries to load through
 * {@link resolveSassSpecifier}, so compile-check resolution matches the module graph's
 * (design doc §5.1): the same alias/load-path configuration applies, and dart-sass's own
 * `loadPaths` option is never used. `entryFile` is the fallback importer when
 * `context.containingUrl` is unavailable (defensive; dart-sass has always populated it for
 * file-based `compileAsync` in practice).
 */
function createFileImporter(entryFile: string, resolver: ResolverFactory, loadPaths: readonly string[]) {
  return {
    findFileUrl(url: string, context: { containingUrl: URL | null }): URL | null {
      const importingFile = context.containingUrl !== null ? fileURLToPath(context.containingUrl) : entryFile;
      const result = resolveSassSpecifier(importingFile, url, resolver, loadPaths);
      if (!result.ok) return null;
      return pathToFileURL(result.path);
    },
  };
}

/** Maps a caught `sass.Exception` to a {@link Diagnostic} (1-based position; design doc §3, principle 4). */
function diagnosticFromException(exception: Exception, entryFile: string): Diagnostic {
  const { span } = exception;
  return {
    file: span.url ? fileURLToPath(span.url) : entryFile,
    // span positions are 0-based; Diagnostic positions are 1-based.
    line: span.start.line + 1,
    column: span.start.column + 1,
    message: exception.sassMessage,
  };
}

/**
 * Checks whether each given file compiles with dart-sass. This is the sanity check that the
 * working codebase actually compiles (design doc §3, principle 4): if it doesn't, the codemod's
 * resolution (`--load-path`/`--alias`) likely isn't reproducing the bundler's configuration.
 *
 * Filtering out partials is the caller's responsibility — this module is generic over the given
 * file list (design doc §13.2, Step 7).
 *
 * Files are compiled serially (M0; no parallelism).
 */
export async function checkSassCompiles(
  files: readonly string[],
  options: SassCompileOptions = {},
): Promise<SassCompileCheck[]> {
  const resolver = createSassResolver(options.alias !== undefined ? { alias: options.alias } : {});
  const loadPaths = options.loadPaths ?? [];

  const checks: SassCompileCheck[] = [];
  for (const file of files) {
    const fileImporter = createFileImporter(file, resolver, loadPaths);
    try {
      // Serial by design (M0; no parallelism, see doc comment above).
      // oxlint-disable-next-line eslint/no-await-in-loop
      await compileAsync(file, { importers: [fileImporter], logger: Logger.silent });
      checks.push({ file, ok: true });
    } catch (error) {
      if (!(error instanceof Exception)) throw error;
      checks.push({ file, ok: false, diagnostic: diagnosticFromException(error, file) });
    }
  }
  return checks;
}
