import dedent from 'dedent';
import { createFixture } from 'fs-fixture';
import { expect, test, describe } from 'vite-plus/test';
import { parseScss } from './parse.ts';
import { createSassResolver, expandSassCandidates, extractImportStatements, resolveSassSpecifier } from './resolve.ts';

const FILE = '/project/a.module.scss';

function statementsOf(source: string, file = FILE) {
  const result = parseScss(source, file);
  expect.assert(result.ok);
  return extractImportStatements(result.root, file);
}

describe('extractImportStatements', () => {
  test('extracts specifier, kind, and position for @use, @forward, and Sass @import', () => {
    const source = dedent`
      @use './theme' as t;
      @forward './mixins';
      @import './legacy';
    `;

    expect(statementsOf(source)).toEqual([
      { kind: 'use', specifier: './theme', file: FILE, line: 1, column: 1 },
      { kind: 'forward', specifier: './mixins', file: FILE, line: 2, column: 1 },
      { kind: 'import', specifier: './legacy', file: FILE, line: 3, column: 1 },
    ]);
  });

  test('skips plain-CSS @import forms (url(), .css specifier, trailing media query)', () => {
    const source = dedent`
      @import url('x.css');
      @import 'x.css';
      @import 'x.css' screen;
    `;

    expect(statementsOf(source)).toEqual([]);
  });

  test('splits a comma-separated @import into individual statements', () => {
    const source = `@import 'a', 'b';\n`;

    expect(statementsOf(source)).toEqual([
      { kind: 'import', specifier: 'a', file: FILE, line: 1, column: 1 },
      { kind: 'import', specifier: 'b', file: FILE, line: 1, column: 1 },
    ]);
  });

  test('skips sass: built-in modules and pkg: specifiers', () => {
    const source = dedent`
      @use 'sass:math';
      @use 'pkg:some-package';
      @import 'sass:color';
    `;

    expect(statementsOf(source)).toEqual([]);
  });
});

describe('expandSassCandidates', () => {
  test('expands an extension-less specifier into file and index candidates', () => {
    expect(expandSassCandidates('theme')).toEqual({
      fileCandidates: ['theme.scss', '_theme.scss', 'theme.css', '_theme.css'],
      indexCandidates: ['theme/index.scss', 'theme/_index.scss'],
    });
  });

  test('expands a specifier with .scss into exact and partial candidates', () => {
    expect(expandSassCandidates('./theme.scss')).toEqual({
      fileCandidates: ['./theme.scss', './_theme.scss'],
      indexCandidates: [],
    });
  });

  test('adds the underscore only to the basename for a specifier with a directory part', () => {
    expect(expandSassCandidates('./nested/theme')).toEqual({
      fileCandidates: ['./nested/theme.scss', './nested/_theme.scss', './nested/theme.css', './nested/_theme.css'],
      indexCandidates: ['./nested/theme/index.scss', './nested/theme/_index.scss'],
    });
  });
});

describe('resolveSassSpecifier', () => {
  test('resolves a bare name to its partial file', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      '_theme.scss': dedent`
        $primary: #06f;
      `,
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), './theme', resolver);

    expect(result).toEqual({ ok: true, path: fixture.getPath('_theme.scss') });
  });

  test('resolves a bare name to its index partial when no matching file exists', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'theme': {
        '_index.scss': dedent`
          $primary: #06f;
        `,
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), './theme', resolver);

    expect(result).toEqual({ ok: true, path: fixture.getPath('theme/_index.scss') });
  });

  test('prefers a file candidate over an index candidate', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'theme.scss': dedent`
        $primary: #06f;
      `,
      'theme': {
        '_index.scss': dedent`
          $primary: #030;
        `,
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), './theme', resolver);

    expect(result).toEqual({ ok: true, path: fixture.getPath('theme.scss') });
  });

  test('returns ambiguous when both theme.scss and _theme.scss exist', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'theme.scss': '',
      '_theme.scss': '',
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), './theme', resolver);

    expect.assert(result.ok === false);
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates.sort()).toEqual([fixture.getPath('_theme.scss'), fixture.getPath('theme.scss')].sort());
  });

  test('returns not-found for a reference that matches no candidate', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), './missing', resolver);

    expect.assert(result.ok === false);
    expect(result.reason).toBe('not-found');
    expect(result.candidates).toEqual([
      './missing.scss',
      './_missing.scss',
      './missing.css',
      './_missing.css',
      './missing/index.scss',
      './missing/_index.scss',
    ]);
  });

  test('resolves a bare specifier into node_modules', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'node_modules': {
        pkg: {
          '_theme.scss': dedent`
            $primary: #06f;
          `,
        },
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'pkg/theme', resolver);

    expect(result).toEqual({ ok: true, path: fixture.getPath('node_modules/pkg/_theme.scss') });
  });

  test('resolves a bare package specifier via the package.json sass field', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'node_modules': {
        pkg: {
          'package.json': JSON.stringify({ name: 'pkg', main: './index.js', sass: './main.scss' }),
          'index.js': '',
          'main.scss': dedent`
            $primary: #06f;
          `,
        },
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'pkg', resolver);

    expect(result).toEqual({ ok: true, path: fixture.getPath('node_modules/pkg/main.scss') });
  });

  test('does not match a package entry that resolves to a non-scss file', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'node_modules': {
        pkg: {
          'package.json': JSON.stringify({ name: 'pkg', sass: './index.js' }),
          'index.js': '',
        },
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'pkg', resolver);

    expect.assert(result.ok === false);
    expect(result.reason).toBe('not-found');
  });

  test('resolves via a load path', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'styles': {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'theme', resolver, [
      fixture.getPath('styles'),
    ]);

    expect(result).toEqual({ ok: true, path: fixture.getPath('styles/_theme.scss') });
  });

  test('prefers a relative match over a load path match', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      '_theme.scss': '',
      'styles': {
        '_theme.scss': '',
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'theme', resolver, [
      fixture.getPath('styles'),
    ]);

    expect(result).toEqual({ ok: true, path: fixture.getPath('_theme.scss') });
  });

  test('prefers a node_modules match over a load path match', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'node_modules': {
        pkg: {
          '_theme.scss': '',
        },
      },
      'styles': {
        pkg: {
          '_theme.scss': '',
        },
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'pkg/theme', resolver, [
      fixture.getPath('styles'),
    ]);

    expect(result).toEqual({ ok: true, path: fixture.getPath('node_modules/pkg/_theme.scss') });
  });

  test('reports ambiguity within a load path directory', async () => {
    await using fixture = await createFixture({
      'a.module.scss': '',
      'styles': {
        'theme.scss': '',
        '_theme.scss': '',
      },
    });
    const resolver = createSassResolver();

    const result = resolveSassSpecifier(fixture.getPath('a.module.scss'), 'theme', resolver, [
      fixture.getPath('styles'),
    ]);

    expect.assert(result.ok === false);
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates.sort()).toEqual(
      [fixture.getPath('styles/_theme.scss'), fixture.getPath('styles/theme.scss')].sort(),
    );
  });
});
