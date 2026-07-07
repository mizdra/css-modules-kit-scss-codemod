import dedent from 'dedent';
import { describe, expect, test } from 'vite-plus/test';
import { parseScss, stringifyScss } from '../core/parse.ts';
import { transformAtStatements } from './at-statements.ts';

const FILE = '/project/a.module.scss';

/** Parses `source`, applies `transformAtStatements`, and returns the re-stringified result plus the transform result. */
function convert(source: string) {
  const result = parseScss(source, FILE);
  expect.assert(result.ok);
  const transformResult = transformAtStatements(result.root, FILE);
  return { output: stringifyScss(result.root), ...transformResult };
}

describe('transformAtStatements', () => {
  test('removes top-level @warn, @debug, and @error at-rules', () => {
    const source = dedent`
      @warn "deprecated: use $primary";
      @debug $primary;
      @error "unsupported value";
      .a { color: red; }
    `;

    const { output, diagnostics } = convert(source);

    expect(diagnostics).toEqual([]);
    expect(output).toBe(dedent`
      .a { color: red; }
    `);
  });

  test('removes @warn nested inside a rule and inside @media', () => {
    const source = dedent`
      .a {
        @warn "inside rule";
        color: red;
      }
      @media (min-width: 100px) {
        .b {
          @warn "inside media";
          color: blue;
        }
      }
    `;

    const { output } = convert(source);

    expect(output).toBe(dedent`
      .a {
        color: red;
      }
      @media (min-width: 100px) {
        .b {
          color: blue;
        }
      }
    `);
  });

  test('records file, position, syntax, and message for each removed at-rule', () => {
    const source = dedent`
      .a {
        color: red;
      }
      @warn "deprecated: use $primary";
    `;

    const { logs } = convert(source);

    expect(logs).toEqual([
      {
        file: FILE,
        line: 4,
        column: 1,
        syntax: '@warn',
        message: 'removed @warn "deprecated: use $primary"',
      },
    ]);
  });

  test('leaves a file without @error/@warn/@debug unchanged with no diagnostics or logs', () => {
    const source = dedent`
      .a { color: red; }
    `;

    const { output, diagnostics, logs } = convert(source);

    expect(output).toBe(source);
    expect(diagnostics).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('is idempotent: applying it again to already-converted output changes nothing and produces no more logs', () => {
    const source = dedent`
      @warn "note";
      .a {
        @debug $x;
        color: red;
      }
    `;

    const once = convert(source);
    const twice = convert(once.output);

    expect(twice.output).toBe(once.output);
    expect(twice.logs).toEqual([]);
  });

  test('does not remove other at-rules such as @media and @keyframes', () => {
    const source = dedent`
      @media (min-width: 100px) {
        .a { color: red; }
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;

    const { output, logs } = convert(source);

    expect(output).toBe(source);
    expect(logs).toEqual([]);
  });
});
