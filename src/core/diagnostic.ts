/** When conversion support for the syntax is planned. "never" means no support is planned. */
export type DiagnosticMilestone = 'M0' | 'M1' | 'M2' | 'M3' | 'never';

export interface Diagnostic {
  /** Path of the file the diagnostic points at. */
  readonly file: string;
  /** 1-based line number. */
  readonly line?: number;
  /** 1-based column number. */
  readonly column?: number;
  /** Name of the Sass construct (e.g. "@extend", "map value"). */
  readonly syntax?: string;
  readonly milestone?: DiagnosticMilestone;
  readonly message: string;
  /** Suggested manual workaround. */
  readonly hint?: string;
}

function formatLocation(diagnostic: Diagnostic): string {
  if (diagnostic.line === undefined || diagnostic.column === undefined) {
    return diagnostic.file;
  }
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
}

/** Renders a milestone as the human-facing label used in diagnostic suffixes and the `todo` report. */
export function formatMilestone(milestone: DiagnosticMilestone): string {
  return milestone === 'never' ? 'no support planned' : `planned: ${milestone}`;
}

function formatSuffix(diagnostic: Diagnostic): string {
  const { syntax, milestone } = diagnostic;
  if (syntax !== undefined && milestone !== undefined) {
    return ` [${syntax}, ${formatMilestone(milestone)}]`;
  }
  if (syntax !== undefined) {
    return ` [${syntax}]`;
  }
  if (milestone !== undefined) {
    return ` [${formatMilestone(milestone)}]`;
  }
  return '';
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = formatLocation(diagnostic);
  const suffix = formatSuffix(diagnostic);
  const hintLine = diagnostic.hint === undefined ? '' : `\n  hint: ${diagnostic.hint}`;
  return `${location}: ${diagnostic.message}${suffix}${hintLine}`;
}

/** Formats diagnostics for human consumption, one entry per diagnostic. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return '';
  return `${diagnostics.map(formatDiagnostic).join('\n')}\n`;
}

/** Formats diagnostics as pretty-printed JSON (an array of Diagnostic objects). */
export function formatDiagnosticsAsJson(diagnostics: readonly Diagnostic[]): string {
  return `${JSON.stringify(diagnostics, null, 2)}\n`;
}
