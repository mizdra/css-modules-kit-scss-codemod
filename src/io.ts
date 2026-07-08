import type { Writable } from 'node:stream';

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  /** Working directory for resolving patterns, `--load-path`, `--alias`, and relativizing report paths. Defaults to `process.cwd()` at the use site. */
  cwd?: string;
}
