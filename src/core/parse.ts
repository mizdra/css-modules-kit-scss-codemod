import { CssSyntaxError } from 'postcss';
import type { Root } from 'postcss';
import { parse, stringify } from 'postcss-scss';
import type { Diagnostic } from './diagnostic.ts';

export type ParseResult =
  | { readonly ok: true; readonly root: Root }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

/** Parses SCSS source with postcss-scss. Returns a diagnostic instead of throwing on syntax errors. */
export function parseScss(source: string, file: string): ParseResult {
  try {
    const root = parse(source, { from: file });
    return { ok: true, root };
  } catch (error) {
    if (error instanceof CssSyntaxError) {
      const diagnostic: Diagnostic = {
        file,
        line: error.line,
        column: error.column,
        message: error.reason,
      };
      return { ok: false, diagnostic };
    }
    throw error;
  }
}

/**
 * Stringifies a root parsed by `parseScss`. postcss's default stringifier does not
 * know about SCSS-only raws (e.g. `//` line comments), so the SCSS-aware one is required
 * to round-trip the source.
 */
export function stringifyScss(root: Root): string {
  return root.toString(stringify);
}
