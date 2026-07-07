import dedent from 'dedent';
import { describe, expect, test } from 'vite-plus/test';
import { parseScss } from './parse.ts';
import { classifyPartial, isPartial, partialClassificationToDiagnostic } from './partial.ts';

const FILE = '/project/_a.scss';

function classify(source: string, file = FILE) {
  const result = parseScss(source, file);
  expect.assert(result.ok);
  return classifyPartial(result.root, file);
}

describe('isPartial', () => {
  test('returns true for a basename starting with an underscore', () => {
    expect(isPartial('_theme.scss')).toBe(true);
  });

  test('returns false for a basename not starting with an underscore', () => {
    expect(isPartial('theme.scss')).toBe(false);
  });

  test('returns true when the underscore is on the basename inside a directory', () => {
    expect(isPartial('styles/_theme.scss')).toBe(true);
  });

  test('returns false when the underscore is only on a directory segment', () => {
    expect(isPartial('_dir/theme.scss')).toBe(false);
  });
});

describe('classifyPartial: definition-only', () => {
  test('classifies a file with $vars, @mixin, @function, @use, @forward, and comments as definition-only', () => {
    const source = dedent`
      $primary: #06f;
      @use './other';
      @forward './base';
      @mixin focus {
        outline: none;
      }
      @function double($x) {
        @return $x * 2;
      }
      // silent comment
      /* loud comment */
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'definition-only' });
  });

  test('classifies an empty file as definition-only', () => {
    expect(classify('')).toEqual({ file: FILE, classification: 'definition-only' });
  });

  test('classifies a comment-only file as definition-only', () => {
    const source = dedent`
      // note
      /* block */
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'definition-only' });
  });

  test('classifies a Sass @import as a definition, not an emission', () => {
    expect(classify("@import './legacy';\n")).toEqual({ file: FILE, classification: 'definition-only' });
  });
});

describe('classifyPartial: style-emitting', () => {
  test('classifies a top-level style rule as style-emitting', () => {
    expect(classify('.a { color: red; }\n')).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a top-level @media as style-emitting', () => {
    const source = dedent`
      @media (min-width: 100px) {
        .a { color: red; }
      }
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a top-level @keyframes as style-emitting', () => {
    const source = dedent`
      @keyframes spin {
        from { transform: rotate(0deg); }
      }
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a top-level @font-face as style-emitting', () => {
    const source = dedent`
      @font-face {
        font-family: 'Foo';
      }
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a top-level @include as style-emitting', () => {
    expect(classify('@include foo;\n')).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a plain-CSS @import (quoted .css specifier) as style-emitting', () => {
    expect(classify("@import 'foo.css';\n")).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a plain-CSS @import (url()) as style-emitting', () => {
    expect(classify("@import url('foo.css');\n")).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies an unknown at-rule as style-emitting (fail-closed)', () => {
    expect(classify('@tailwind utilities;\n')).toEqual({ file: FILE, classification: 'style-emitting' });
  });

  test('classifies a top-level @if as style-emitting (fail-closed)', () => {
    const source = dedent`
      @if $x == 1 {
        color: red;
      }
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'style-emitting' });
  });
});

describe('classifyPartial: neutral nodes never flip the result', () => {
  test('keeps definition-only when @error/@warn/@debug/@charset accompany definitions', () => {
    const source = dedent`
      $primary: #06f;
      @error "x";
      @warn "y";
      @debug "z";
      @charset "UTF-8";
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'definition-only' });
  });

  test('keeps style-emitting when @error/@warn/@debug/@charset accompany a style rule', () => {
    const source = dedent`
      .a { color: red; }
      @error "x";
      @warn "y";
      @debug "z";
      @charset "UTF-8";
    `;

    expect(classify(source)).toEqual({ file: FILE, classification: 'style-emitting' });
  });
});

describe('classifyPartial: mixed', () => {
  test('classifies definitions followed by a style rule as mixed, anchored at the style rule', () => {
    const source = dedent`
      $primary: #06f;
      .a { color: red; }
    `;

    const result = classify(source);
    expect(result).toEqual({
      file: FILE,
      classification: 'mixed',
      mixedAt: { line: 2, column: 1, syntax: 'style rule' },
    });
  });

  test('classifies a style rule followed by a definition as mixed, anchored at the definition', () => {
    const source = dedent`
      .a { color: red; }
      $primary: #06f;
    `;

    const result = classify(source);
    expect(result).toEqual({
      file: FILE,
      classification: 'mixed',
      mixedAt: { line: 2, column: 1, syntax: 'variable declaration' },
    });
  });

  test('converts a mixed result into an exact diagnostic', () => {
    const source = dedent`
      $primary: #06f;
      .a { color: red; }
    `;

    const result = classify(source);
    expect(partialClassificationToDiagnostic(result)).toEqual({
      file: FILE,
      line: 2,
      column: 1,
      syntax: 'mixed partial',
      milestone: 'never',
      message: 'partial contains both definitions and style-emitting rules',
      hint: 'Split the file into a definition-only partial and a style-emitting partial.',
    });
  });

  test('returns undefined from partialClassificationToDiagnostic for a non-mixed result', () => {
    expect(partialClassificationToDiagnostic(classify('$primary: #06f;\n'))).toBeUndefined();
    expect(partialClassificationToDiagnostic(classify('.a { color: red; }\n'))).toBeUndefined();
  });
});
