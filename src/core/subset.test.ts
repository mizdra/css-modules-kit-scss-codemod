import dedent from 'dedent';
import { expect, test } from 'vite-plus/test';
import { parseScss } from './parse.ts';
import { analyzeSubset, subsetFindingToDiagnostic } from './subset.ts';

const FILE = '/project/a.module.scss';

function findings(source: string, file = FILE) {
  const result = parseScss(source, file);
  expect.assert(result.ok);
  return analyzeSubset(result.root, file);
}

// ---------- No findings (kept as-is) ----------

test('produces no findings for a plain CSS file with comments, media bubbling, and non-concatenating nesting', () => {
  const source = dedent`
    .a {
      color: red;
      /* loud comment */
    }
    @media (min-width: 100px) {
      .b { color: blue; }
    }
    .c {
      &:hover { color: green; }
      & .child { color: purple; }
      &.active { color: orange; }
    }
  `;

  expect(findings(source)).toEqual([]);
});

test('produces no findings for a top-level variable declaration and its reference', () => {
  const source = dedent`
    $var: #06f;
    .a { color: $var; }
  `;

  expect(findings(source)).toEqual([]);
});

test('produces no findings for calc() with a Sass variable and a literal operator', () => {
  expect(findings('.a { width: calc($gap * 2); }\n')).toEqual([]);
});

test('produces no findings for a font shorthand using a literal slash', () => {
  expect(findings('.a { font: 12px/30px sans-serif; }\n')).toEqual([]);
});

test('produces no findings for a literal-only division outside calc()', () => {
  expect(findings('.a { grid-row: 1 / 3; }\n')).toEqual([]);
});

test('produces no findings for plain-CSS @import forms (url(), .css specifier, trailing media query)', () => {
  const source = dedent`
    @import url('x.css');
    @import 'x.css';
    @import 'x.css' screen;
  `;

  expect(findings(source)).toEqual([]);
});

test('produces no findings for a CSS whitelist function with only literal arguments', () => {
  expect(findings('.a { background: linear-gradient(red, blue); }\n')).toEqual([]);
});

test('produces no findings for negative percentage/length literals', () => {
  expect(findings('.a { transform: translate(-50%, -50%); }\n')).toEqual([]);
  expect(findings('.a { margin: -4px  10px; }\n')).toEqual([]);
});

test('produces no findings for a custom property value that only looks like arithmetic', () => {
  expect(findings('.a { --x: a + b; }\n')).toEqual([]);
});

test('produces no findings for a vendor-prefixed known CSS at-rule', () => {
  const source = dedent`
    @-webkit-keyframes spin {
      from { transform: rotate(0deg); }
    }
  `;

  expect(findings(source)).toEqual([]);
});

test('produces no findings for the 4-argument (plain CSS) form of rgba()', () => {
  expect(findings('.a { color: rgba(0, 0, 0, 0.5); }\n')).toEqual([]);
});

test('produces no findings for the 1-argument (CSS filter) form of saturate()', () => {
  expect(findings('.a { filter: saturate(50%); }\n')).toEqual([]);
});

test('produces no findings for space-separated list values, at top level or in a declaration', () => {
  expect(findings('.a { margin: 0 auto; }\n')).toEqual([]);
  expect(findings('$pad: 0 auto;\n')).toEqual([]);
});

// ---------- convert findings ----------

test('classifies a silent comment as convertible by the comments stage', () => {
  expect(findings('// note\n.a { color: red; }\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: 'silent comment', action: { kind: 'convert', stage: 'comments' } },
  ]);
});

test('classifies @warn, @error, and @debug as convertible by the at-statements stage', () => {
  const source = dedent`
    @warn "x";
    @error "y";
    @debug "z";
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@warn', action: { kind: 'convert', stage: 'at-statements' } },
    { file: FILE, line: 2, column: 1, syntax: '@error', action: { kind: 'convert', stage: 'at-statements' } },
    { file: FILE, line: 3, column: 1, syntax: '@debug', action: { kind: 'convert', stage: 'at-statements' } },
  ]);
});

test('classifies a single-selector `&` concatenation as convertible by the nesting stage', () => {
  const source = dedent`
    .a {
      &_bar { color: red; }
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 2, column: 3, syntax: 'selector concatenation', action: { kind: 'convert', stage: 'nesting' } },
  ]);
});

test('classifies `&` concatenation in one branch of a multi-selector rule', () => {
  expect(findings('.a, &_b {\n  color: red;\n}\n')).toEqual([
    { file: FILE, line: 1, column: 5, syntax: 'selector concatenation', action: { kind: 'convert', stage: 'nesting' } },
  ]);
});

test('classifies spaced and unspaced Sass addition as convertible by the expressions stage', () => {
  expect(findings('.a { width: $a + $b; }\n')).toEqual([
    { file: FILE, line: 1, column: 16, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } },
  ]);
  expect(findings('.a { width: $a+$b; }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } },
  ]);
});

test('classifies unary negation of a variable as convertible by the expressions stage', () => {
  expect(findings('.a { width: -$a; }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } },
  ]);
});

test('classifies division involving a variable as convertible by the expressions stage', () => {
  expect(findings('.a { width: $size / 2; }\n')).toEqual([
    { file: FILE, line: 1, column: 18, syntax: 'division', action: { kind: 'convert', stage: 'expressions' } },
  ]);
});

test('classifies math.div() as convertible by the expressions stage, using the canonical name even when aliased', () => {
  const unaliased = dedent`
    @use 'sass:math';
    .a { width: math.div($a, 2); }
  `;
  expect(findings(unaliased)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 13, syntax: 'math.div', action: { kind: 'convert', stage: 'expressions' } },
  ]);

  const aliased = dedent`
    @use 'sass:math' as m;
    .a { width: m.div($a, 2); }
  `;
  expect(findings(aliased)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 13, syntax: 'math.div', action: { kind: 'convert', stage: 'expressions' } },
  ]);
});

test('classifies an unqualified @use of a user module as convertible by the modules stage', () => {
  expect(findings("@use './theme' as t;\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
  ]);
});

test('classifies a namespaced variable reference as convertible by the modules stage', () => {
  const source = dedent`
    @use './theme' as t;
    .a { color: t.$primary; }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 13, syntax: 'namespaced variable', action: { kind: 'convert', stage: 'modules' } },
  ]);
});

test('classifies a namespaced @include as both a mixins and a modules finding', () => {
  const source = dedent`
    @use './theme' as t;
    @include t.foo;
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 1, syntax: '@include', action: { kind: 'convert', stage: 'mixins' } },
    {
      file: FILE,
      line: 2,
      column: 1,
      syntax: 'namespaced mixin reference',
      action: { kind: 'convert', stage: 'modules' },
    },
  ]);
});

test('classifies an unmodified @forward as convertible by the modules stage', () => {
  expect(findings("@forward './base';\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@forward', action: { kind: 'convert', stage: 'modules' } },
  ]);
});

test('does not mistake modifier keywords inside a specifier path or string argument for clauses', () => {
  expect(findings("@forward './as/base';\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@forward', action: { kind: 'convert', stage: 'modules' } },
  ]);
  expect(findings("@use './with-theme';\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
  ]);
  expect(findings("@include foo('using');\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@include', action: { kind: 'convert', stage: 'mixins' } },
  ]);
});

test('classifies a Sass @import as convertible by the modules stage', () => {
  expect(findings("@import './legacy';\n")).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@import (Sass)', action: { kind: 'convert', stage: 'modules' } },
  ]);
});

test('classifies @mixin, @include, and @content as convertible by the mixins stage', () => {
  expect(findings('@mixin foo($a, $b: 1px) {\n  color: $a;\n}\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@mixin', action: { kind: 'convert', stage: 'mixins' } },
  ]);
  expect(findings('@include foo(1px);\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@include', action: { kind: 'convert', stage: 'mixins' } },
  ]);
  expect(findings('@mixin foo {\n  @content;\n}\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@mixin', action: { kind: 'convert', stage: 'mixins' } },
    { file: FILE, line: 2, column: 3, syntax: '@content', action: { kind: 'convert', stage: 'mixins' } },
  ]);
});

test('classifies interpolation of a single variable as convertible by the interpolation stage', () => {
  expect(findings('.a { width: #{$gap}; }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'interpolation', action: { kind: 'convert', stage: 'interpolation' } },
  ]);
  expect(findings('.a { prop-#{$n}: red; }\n')).toEqual([
    { file: FILE, line: 1, column: 6, syntax: 'interpolation', action: { kind: 'convert', stage: 'interpolation' } },
  ]);
  expect(findings('.#{$cls} { color: red; }\n')).toEqual([
    { file: FILE, line: 1, column: 2, syntax: 'interpolation', action: { kind: 'convert', stage: 'interpolation' } },
  ]);
  expect(findings('@keyframes #{$n} {\n  from { opacity: 0; }\n}\n')).toEqual([
    { file: FILE, line: 1, column: 12, syntax: 'interpolation', action: { kind: 'convert', stage: 'interpolation' } },
  ]);
});

test('classifies Sass color functions as convertible by the colors stage', () => {
  const darken = dedent`
    @use 'sass:color';
    .a { color: darken($c, 10%); }
  `;
  expect(findings(darken)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 13, syntax: 'darken', action: { kind: 'convert', stage: 'colors' } },
  ]);

  expect(findings('.a { color: rgba($c, 0.5); }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'rgba($color, $alpha)', action: { kind: 'convert', stage: 'colors' } },
  ]);

  expect(findings('.a { color: mix($a, $b, 30%); }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'mix', action: { kind: 'convert', stage: 'colors' } },
  ]);

  expect(findings('.a { color: saturate($c, 20%); }\n')).toEqual([
    { file: FILE, line: 1, column: 13, syntax: 'saturate', action: { kind: 'convert', stage: 'colors' } },
  ]);

  const colorAdjust = dedent`
    @use 'sass:color';
    .a { color: color.adjust($c, $lightness: 10%); }
  `;
  expect(findings(colorAdjust)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@use', action: { kind: 'convert', stage: 'modules' } },
    { file: FILE, line: 2, column: 13, syntax: 'color.adjust', action: { kind: 'convert', stage: 'colors' } },
  ]);
});

// ---------- unsupported findings ----------

test('rejects a map value in a variable declaration', () => {
  expect(findings('$colors: (a: 1);\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: 'map/list value', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
});

test('rejects !default and !global flags', () => {
  expect(findings('$x: 1 !default;\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '!default', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
  expect(findings('$x: 1 !global;\n')).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '!global', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
});

test('rejects a local (rule-scoped) variable declaration as an M3 milestone item', () => {
  const source = dedent`
    .a {
      $x: 1px;
      color: $x;
    }
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 2,
      column: 3,
      syntax: 'local variable declaration',
      action: {
        kind: 'unsupported',
        milestone: 'M3',
        hint: 'Move the declaration to the top level, or inline the value at each use site.',
      },
    },
  ]);
});

test('rejects control-flow at-rules (@if, @each, @for, @while, @else)', () => {
  const source = dedent`
    @if $x == 1 {
      color: red;
    }
    @each $i in $list {
      color: red;
    }
    @for $i from 1 through 3 {
      color: red;
    }
    @while $x > 0 {
      color: red;
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@if', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 4, column: 1, syntax: '@each', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 7, column: 1, syntax: '@for', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 10, column: 1, syntax: '@while', action: { kind: 'unsupported', milestone: 'never' } },
  ]);

  const elseSource = dedent`
    @if $x == 1 {
      color: red;
    } @else if $x == 2 {
      color: blue;
    } @else {
      color: green;
    }
  `;

  expect(findings(elseSource)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@if', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 3, column: 3, syntax: '@else', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 5, column: 3, syntax: '@else', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
});

test('rejects user-defined @function and @return', () => {
  const source = dedent`
    @function foo($x) {
      @return $x;
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@function', action: { kind: 'unsupported', milestone: 'never' } },
    { file: FILE, line: 2, column: 3, syntax: '@return', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
});

test('rejects @extend with a hint to use composes or expansion', () => {
  const source = dedent`
    .a {
      @extend .b;
    }
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 2,
      column: 3,
      syntax: '@extend',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'Rewrite manually with `composes`, or expand the extended rule into this one — the general form of `@extend` (compound selectors, `%placeholder`) has no automatic dialect equivalent.',
      },
    },
  ]);
});

test('rejects a placeholder selector rule', () => {
  const source = dedent`
    %foo {
      color: red;
    }
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: 'placeholder selector',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects @at-root as an M3 milestone item', () => {
  const source = dedent`
    .a {
      @at-root .b {
        color: red;
      }
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 2, column: 3, syntax: '@at-root', action: { kind: 'unsupported', milestone: 'M3' } },
  ]);
});

test('rejects @use with a configuration clause', () => {
  expect(findings("@use './x' with ($a: 1);\n")).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: '@use ... with (configuration)',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects @forward with a show/hide/as/with modifier', () => {
  expect(findings("@forward './x' show $a;\n")).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: '@forward with modifiers',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects rest arguments in a @mixin definition', () => {
  const source = dedent`
    @mixin bar($args...) {
      color: red;
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: 'rest arguments', action: { kind: 'unsupported', milestone: 'never' } },
  ]);
});

test('rejects @content with arguments', () => {
  const source = dedent`
    @mixin foo {
      @content (x);
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: '@mixin', action: { kind: 'convert', stage: 'mixins' } },
    {
      file: FILE,
      line: 2,
      column: 3,
      syntax: '@content with arguments',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects @include with a `using` clause', () => {
  const source = dedent`
    @include foo using ($x) {
      color: red;
    }
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: '@include ... using',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects interpolation containing an expression, in a value and inside a quoted string', () => {
  const hint =
    'Interpolation containing an expression has no dialect equivalent; pre-compute the value or restructure the code so the interpolation body is a single variable.';

  expect(findings('.a { width: #{$a + $b}; }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'interpolation containing an expression',
      action: { kind: 'unsupported', milestone: 'never', hint },
    },
  ]);

  expect(findings('.a { content: "#{$a + $b}"; }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 16,
      syntax: 'interpolation containing an expression',
      action: { kind: 'unsupported', milestone: 'never', hint },
    },
  ]);
});

test('rejects list/map/string builtin functions with no CSS counterpart', () => {
  expect(findings('.a { width: map-get($m, k); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'map-get',
      action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS counterpart; rewrite manually.' },
    },
  ]);

  expect(findings('.a { width: unique-id(); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'unique-id',
      action: { kind: 'unsupported', milestone: 'never', hint: 'No CSS counterpart; rewrite manually.' },
    },
  ]);
});

test('rejects Sass if()', () => {
  expect(findings('.a { width: if($c, 1px, 2px); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'if()',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'Sass `if()` has no safe CSS equivalent here; rewrite manually.',
      },
    },
  ]);
});

test('rejects invert() with a non-literal argument, but keeps the plain CSS filter form', () => {
  expect(findings('.a { filter: invert($c); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 14,
      syntax: 'invert',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'The CSS filter form and the Sass color function `invert` are indistinguishable here without evaluating the argument.',
      },
    },
  ]);

  expect(findings('.a { filter: invert(0.5); }\n')).toEqual([]);
});

test('rejects an unknown function with a hint to report or rewrite it', () => {
  expect(findings('.a { width: my-func(1px); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'unknown function "my-func()"',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'If this is a plain CSS function, please report it; if it is a Sass function, rewrite it manually.',
      },
    },
  ]);
});

test('rejects an unknown at-rule (fail-closed)', () => {
  expect(findings('@tailwind utilities;\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: 'unknown at-rule "@tailwind"',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects `&` concatenation whose suffix contains interpolation', () => {
  const source = dedent`
    .a {
      &-#{$n} { color: red; }
    }
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 2,
      column: 3,
      syntax: 'selector concatenation with interpolation',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

test('rejects a call through an unresolved namespace', () => {
  expect(findings('.a { width: ns.fn(1px); }\n')).toEqual([
    {
      file: FILE,
      line: 1,
      column: 13,
      syntax: 'ns.fn',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'User-defined or unresolved namespaced function; rewrite the call result manually.',
      },
    },
  ]);
});

test('rejects a selector nested deeper than postcss-selector-parser can parse (fail-closed)', () => {
  const depth = 300;
  const selector = `${':not('.repeat(depth)}.x${')'.repeat(depth)}`;

  expect(findings(`${selector} { color: red; }\n`)).toEqual([
    {
      file: FILE,
      line: 1,
      column: 1,
      syntax: 'unparsable selector',
      action: { kind: 'unsupported', milestone: 'never' },
    },
  ]);
});

// ---------- Positions ----------

test('reports the exact line and column of a value-level finding in a multi-line file', () => {
  const source = dedent`
    .a {
      color: red;
      width: $a + $b;
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 3, column: 13, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } },
  ]);
});

test('reports the exact line and column of a selector-level finding in a multi-line file', () => {
  const source = dedent`
    .a {
      &_bar {
        color: red;
      }
    }
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 2, column: 3, syntax: 'selector concatenation', action: { kind: 'convert', stage: 'nesting' } },
  ]);
});

test('reports the exact line and column of a node-level finding in a multi-line file', () => {
  const source = dedent`
    .a {
      color: red;
    }
    @extend .b;
  `;

  expect(findings(source)).toEqual([
    {
      file: FILE,
      line: 4,
      column: 1,
      syntax: '@extend',
      action: {
        kind: 'unsupported',
        milestone: 'never',
        hint: 'Rewrite manually with `composes`, or expand the extended rule into this one — the general form of `@extend` (compound selectors, `%placeholder`) has no automatic dialect equivalent.',
      },
    },
  ]);
});

// ---------- Multiple findings in one file ----------

test('returns every finding in source order for a file mixing several constructs', () => {
  const source = dedent`
    // note
    .a {
      &_bar {
        color: $a + $b;
      }
    }
    @warn "x";
  `;

  expect(findings(source)).toEqual([
    { file: FILE, line: 1, column: 1, syntax: 'silent comment', action: { kind: 'convert', stage: 'comments' } },
    { file: FILE, line: 3, column: 3, syntax: 'selector concatenation', action: { kind: 'convert', stage: 'nesting' } },
    { file: FILE, line: 4, column: 15, syntax: 'arithmetic', action: { kind: 'convert', stage: 'expressions' } },
    { file: FILE, line: 7, column: 1, syntax: '@warn', action: { kind: 'convert', stage: 'at-statements' } },
  ]);
});

// ---------- subsetFindingToDiagnostic ----------

test('converts a convert finding to a Diagnostic using the stage milestone from STAGES', () => {
  const diagnostic = subsetFindingToDiagnostic({
    file: FILE,
    line: 1,
    column: 1,
    syntax: 'silent comment',
    action: { kind: 'convert', stage: 'comments' },
  });

  expect(diagnostic).toEqual({
    file: FILE,
    line: 1,
    column: 1,
    syntax: 'silent comment',
    milestone: 'M0',
    message: 'convertible by the "comments" stage',
  });
});

test('converts an unsupported finding with a hint to a Diagnostic', () => {
  const diagnostic = subsetFindingToDiagnostic({
    file: FILE,
    line: 2,
    column: 3,
    syntax: '@extend',
    action: {
      kind: 'unsupported',
      milestone: 'never',
      hint: 'Rewrite manually with `composes`, or expand the extended rule into this one.',
    },
  });

  expect(diagnostic).toEqual({
    file: FILE,
    line: 2,
    column: 3,
    syntax: '@extend',
    milestone: 'never',
    message: '"@extend" is not supported',
    hint: 'Rewrite manually with `composes`, or expand the extended rule into this one.',
  });
});
