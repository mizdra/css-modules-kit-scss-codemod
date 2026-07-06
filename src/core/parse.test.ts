import dedent from 'dedent';
import { expect, test } from 'vite-plus/test';
import { parseScss, stringifyScss } from './parse.ts';

test('parses valid SCSS and returns the root node', () => {
  const source = dedent`
    .a { color: red; }
  `;

  const result = parseScss(source, '/project/a.module.scss');

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.root.type).toBe('root');
  expect(result.root.first?.type).toBe('rule');
});

test('parses SCSS-specific syntax that plain CSS parsers reject', () => {
  const source = dedent`
    // note
    $var: red;
    .a {
      &_suffix {
        color: $var;
      }
    }
    @mixin foo {
      color: $var;
    }
  `;

  const result = parseScss(source, '/project/a.module.scss');

  expect(result.ok).toBe(true);
});

test('round-trips the source exactly through stringification', () => {
  const source = dedent`
    .a {
        color: red; // inline comment

      .b {
       color: blue;
      }
    }
  `;

  const result = parseScss(source, '/project/a.module.scss');

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(stringifyScss(result.root)).toBe(source);
});

test("records the file path on the parsed root's source input", () => {
  const source = dedent`
    .a { color: red; }
  `;

  const result = parseScss(source, '/project/a.module.scss');

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.root.source?.input.file).toBe('/project/a.module.scss');
});

test('returns a diagnostic with 1-based line and column for a syntax error', () => {
  const source = dedent`
    .a {
      color: red;
  `;

  const result = parseScss(source, '/project/a.module.scss');

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.diagnostic.file).toBe('/project/a.module.scss');
  expect(typeof result.diagnostic.line).toBe('number');
  expect(typeof result.diagnostic.column).toBe('number');
  expect(result.diagnostic.message).not.toContain('/project/a.module.scss');
});
