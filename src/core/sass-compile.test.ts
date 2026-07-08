import dedent from 'dedent';
import { createFixture } from 'fs-fixture';
import { describe, expect, test } from 'vite-plus/test';
import { checkSassCompiles } from './sass-compile.ts';

describe('checkSassCompiles', () => {
  test('reports ok for a file that compiles', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        .a { color: red; }
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')]);

    expect(checks).toEqual([{ file: fixture.getPath('a.module.scss'), ok: true }]);
  });

  test('reports a diagnostic with a 1-based position for a file that fails to compile', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        .a {
          color: $missing;
        }
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')]);

    expect(checks).toEqual([
      {
        file: fixture.getPath('a.module.scss'),
        ok: false,
        diagnostic: {
          file: fixture.getPath('a.module.scss'),
          line: 2,
          column: 10,
          message: 'Undefined variable.',
        },
      },
    ]);
  });

  test('resolves a relative partial import during compilation', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        @use './theme' as t;
        .a { color: t.$primary; }
      `,
      '_theme.scss': dedent`
        $primary: #06f;
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')]);

    expect(checks).toEqual([{ file: fixture.getPath('a.module.scss'), ok: true }]);
  });

  test('resolves an import through a load path during compilation', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        @use 'theme' as t;
        .a { color: t.$primary; }
      `,
      'styles': {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')], {
      loadPaths: [fixture.getPath('styles')],
    });

    expect(checks).toEqual([{ file: fixture.getPath('a.module.scss'), ok: true }]);
  });

  test('resolves an import through an alias during compilation', async () => {
    await using fixture = await createFixture({
      app: {
        'a.module.scss': dedent`
          @use '@/theme' as t;
          .a { color: t.$primary; }
        `,
      },
      src: {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const checks = await checkSassCompiles([fixture.getPath('app/a.module.scss')], {
      alias: { '@': [fixture.getPath('src')] },
    });

    expect(checks).toEqual([{ file: fixture.getPath('app/a.module.scss'), ok: true }]);
  });

  test('points the diagnostic at the imported partial when the error is inside it', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        @use './theme';
      `,
      '_theme.scss': dedent`
        .b {
          color: $missing;
        }
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')]);

    expect(checks).toEqual([
      {
        file: fixture.getPath('a.module.scss'),
        ok: false,
        diagnostic: {
          file: fixture.getPath('_theme.scss'),
          line: 2,
          column: 10,
          message: 'Undefined variable.',
        },
      },
    ]);
  });

  test('reports a diagnostic when an import cannot be resolved', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        @use './missing';
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('a.module.scss')]);

    expect(checks).toHaveLength(1);
    const [check] = checks;
    expect.assert(check !== undefined);
    expect(check.ok).toBe(false);
    expect(check.diagnostic?.file).toBe(fixture.getPath('a.module.scss'));
    expect(check.diagnostic?.message).toBe("Can't find stylesheet to import.");
  });

  test('checks multiple files independently', async () => {
    await using fixture = await createFixture({
      'good.module.scss': dedent`
        .a { color: red; }
      `,
      'bad.module.scss': dedent`
        .b {
          color: $missing;
        }
      `,
    });

    const checks = await checkSassCompiles([fixture.getPath('good.module.scss'), fixture.getPath('bad.module.scss')]);

    expect(checks).toEqual([
      { file: fixture.getPath('good.module.scss'), ok: true },
      {
        file: fixture.getPath('bad.module.scss'),
        ok: false,
        diagnostic: {
          file: fixture.getPath('bad.module.scss'),
          line: 2,
          column: 10,
          message: 'Undefined variable.',
        },
      },
    ]);
  });
});
