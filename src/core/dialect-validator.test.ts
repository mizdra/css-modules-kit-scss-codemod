import dedent from 'dedent';
import { describe, expect, test } from 'vite-plus/test';
import { validateDialect } from './dialect-validator.ts';

function filesMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries).map(([file, source]) => [`/project/${file}`, source]));
}

describe('validateDialect', () => {
  describe('accepted dialect files', () => {
    test('accepts the design doc §9.2 example (top-level $var, @define-mixin/@mixin, @import)', async () => {
      const files = filesMap({
        'theme.css': dedent`
          $primary: #0066ff;
          @define-mixin focus {
            outline: 2px solid $primary;
          }
        `,
        'button.module.css': dedent`
          @import './theme.css';
          .btn {
            color: $primary;
            @mixin focus;
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts nesting (&:hover, &_ concatenation, at-rule bubbling)', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .card {
            color: red;
            &:hover { color: blue; }
            &_title { font-weight: bold; }
            @media (min-width: 100px) {
              color: green;
            }
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts $(x) interpolation in a selector and a property name', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          $name: btn;
          $prop: color;
          .$(name) {
            $(prop): red;
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts a top-level $var declaration and reference', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          $gap: 8px;
          .a { margin: $gap; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts known CSS at-rules such as @media, @supports, @keyframes', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          @media (min-width: 100px) {
            .a { color: red; }
          }
          @supports (display: grid) {
            .b { display: grid; }
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts calc() and CSS math functions with a literal operator', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          $gap: 4px;
          $a: 1px;
          $b: 2px;
          .a { width: calc($gap * 2 + 1px); }
          .b { height: min($a, $b); }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('accepts a font shorthand and grid-area using literal slashes', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .a { font: 16px/1.5 sans-serif; }
          .b { grid-area: 1 / 2; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });
  });

  describe('rejects residual Sass constructs that the standard postcss parser would accept', () => {
    const rejectedSources: Record<string, string> = {
      '@use': '@use "./theme";\n',
      '@include': '.a { @include focus; }\n',
      '@content': '@define-mixin focus { @content; }\n',
      'silent comment': '// a comment\n.a { color: red; }\n',
      '#{$x} in a value': '.a { color: #{$x}; }\n',
      '#{$x} in a selector': '.#{$x} { color: red; }\n',
      '#{$x} in a property name': '.a { #{$x}: red; }\n',
      'local $var declaration': '.a { $local: red; color: $local; }\n',
      '%placeholder selector': '%foo { color: red; }\n',
      'Sass @import without extension': "@import './theme';\n",
      'namespaced variable reference': '.a { color: t.$primary; }\n',
      'namespaced function call': '.a { width: math.div($a, $b); }\n',
      'Sass arithmetic outside calc()': '.a { margin: $a + $b; }\n',
      '@if': '@if $x == 1 { .a { color: red; } }\n',
      'unknown at-rule': '@each $i in 1, 2, 3 { .a { color: red; } }\n',
    };

    for (const [label, source] of Object.entries(rejectedSources)) {
      test(`rejects ${label}`, async () => {
        const files = filesMap({ 'a.module.css': source });

        const { diagnostics } = await validateDialect(files);

        expect(diagnostics.length).toBeGreaterThan(0);
      });
    }

    test('reports a position (line and column) on a rejected diagnostic', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .a {
            color: #{$x};
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.line).toBe(2);
      expect(typeof diagnostics[0]?.column).toBe('number');
    });

    test('allows & concatenation while still rejecting a placeholder selector in the same file', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .card {
            &_title { color: red; }
          }
          %foo { color: blue; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.syntax).toBe('placeholder selector');
    });
  });

  describe('plugin pipeline execution', () => {
    test('reports a diagnostic for an undefined mixin application', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .a { @mixin nonexistent; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toMatch(/undefined mixin/iu);
    });

    test('reports a diagnostic for an undefined variable reference', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          .a { color: $missing; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toMatch(/undefined variable/iu);
    });

    test('inlines a relative @import so a definition in another file is visible', async () => {
      const files = filesMap({
        'theme.css': dedent`
          $primary: #0066ff;
          @define-mixin focus {
            outline: 2px solid $primary;
          }
        `,
        'button.module.css': dedent`
          @import './theme.css';
          .btn {
            color: $primary;
            @mixin focus;
          }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });

    test('reports a diagnostic for a circular @import and does not hang', async () => {
      const files = filesMap({
        'a.css': dedent`
          @import './b.css';
          .a { color: red; }
        `,
        'b.css': dedent`
          @import './a.css';
          .b { color: blue; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.some((d) => d.syntax === '@import' && d.message.includes('Circular'))).toBe(true);
    });

    test('leaves an @import that does not resolve within the file set untouched (external reference)', async () => {
      const files = filesMap({
        'a.module.css': dedent`
          @import 'external-package/reset.css';
          .a { color: red; }
        `,
      });

      const { diagnostics } = await validateDialect(files);

      expect(diagnostics).toEqual([]);
    });
  });
});
