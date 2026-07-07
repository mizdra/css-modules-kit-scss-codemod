import dedent from 'dedent';
import { parse as parseStandardCss } from 'postcss';
import { describe, expect, test } from 'vite-plus/test';
import { parseScss, stringifyScss } from '../core/parse.ts';
import { transformComments } from './comments.ts';

const FILE = '/project/a.module.scss';

/** Parses `source`, applies `transformComments`, and returns the re-stringified result. */
function convert(source: string): string {
  const result = parseScss(source, FILE);
  expect.assert(result.ok);
  const transformResult = transformComments(result.root, FILE);
  expect(transformResult).toEqual({ diagnostics: [], logs: [] });
  return stringifyScss(result.root);
}

describe('transformComments', () => {
  test('converts a top-level silent comment into a loud comment, preserving surrounding formatting', () => {
    const source = dedent`
      // Theme variables
      $primary: #06f;
    `;

    expect(convert(source)).toBe(dedent`
      /* Theme variables */
      $primary: #06f;
    `);
  });

  test('converts silent comments nested inside rules and at-rules', () => {
    const source = dedent`
      .button {
        // hover state
        &:hover {
          color: red; // inline note
        }
      }
    `;

    expect(convert(source)).toBe(dedent`
      .button {
        /* hover state */
        &:hover {
          color: red; /* inline note */
        }
      }
    `);
  });

  test('leaves an already-loud comment untouched', () => {
    const source = dedent`
      /* already loud */
      .a { color: red; }
    `;

    expect(convert(source)).toBe(source);
  });

  test('escapes an embedded closing delimiter by inserting a space, and the result is standard-CSS parseable', () => {
    // Built without dedent to pin down the exact trailing whitespace the mapping depends on.
    const source = '// note */ done \n.a { color: red; }\n';

    const output = convert(source);

    expect(output).toBe('/* note * / done */\n.a { color: red; }\n');
    expect(() => parseStandardCss(output)).not.toThrow();
    const reparsed = parseStandardCss(output);
    const [comment] = reparsed.nodes;
    expect.assert(comment?.type === 'comment');
    expect(comment.text).toBe('note * / done');
  });

  test('converts an empty silent comment into an empty loud comment', () => {
    const source = dedent`
      //
      .a { color: red; }
    `;

    expect(convert(source)).toBe(dedent`
      /**/
      .a { color: red; }
    `);
  });

  test('is idempotent: applying it again to already-converted output changes nothing', () => {
    const source = dedent`
      // note */ still valid
      .a {
        // nested
        color: red;
      }
    `;

    const once = convert(source);
    const twice = convert(once);

    expect(twice).toBe(once);
  });

  test('produces no diagnostics or logs for a file with no comments', () => {
    const result = parseScss('.a { color: red; }', FILE);
    expect.assert(result.ok);

    const transformResult = transformComments(result.root, FILE);

    expect(transformResult).toEqual({ diagnostics: [], logs: [] });
    expect(stringifyScss(result.root)).toBe('.a { color: red; }');
  });
});
