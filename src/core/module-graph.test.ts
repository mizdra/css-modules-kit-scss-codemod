import dedent from 'dedent';
import { createFixture, type FsFixture } from 'fs-fixture';
import type { Root } from 'postcss';
import { describe, expect, test } from 'vite-plus/test';
import { buildModuleGraph, importersOf } from './module-graph.ts';
import { parseScss } from './parse.ts';

/** Parses every listed file (relative to the fixture root) and returns the map `buildModuleGraph` expects. */
async function parsedFilesOf(fixture: FsFixture, files: readonly string[]): Promise<Map<string, Root>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const path = fixture.getPath(file);
      const source = await fixture.readFile(file, 'utf8');
      const result = parseScss(source, path);
      expect.assert(result.ok);
      return [path, result.root] as const;
    }),
  );
  return new Map(entries);
}

describe('buildModuleGraph', () => {
  test('builds importer to imported edges from @use, @forward, and @import within the target set', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        @use './theme' as t;
        @forward './mixins';
        @import './legacy';
      `,
      '_theme.scss': dedent`
        $primary: #06f;
      `,
      '_mixins.scss': dedent`
        @mixin focus { outline: none; }
      `,
      '_legacy.scss': dedent`
        $old: #ccc;
      `,
    });
    const parsedFiles = await parsedFilesOf(fixture, [
      'consumer.module.scss',
      '_theme.scss',
      '_mixins.scss',
      '_legacy.scss',
    ]);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(diagnostics).toEqual([]);
    const consumer = fixture.getPath('consumer.module.scss');
    const edges = graph.edges.get(consumer);
    expect.assert(edges !== undefined);
    expect(edges.map((edge) => edge.resolvedPath)).toEqual([
      fixture.getPath('_theme.scss'),
      fixture.getPath('_mixins.scss'),
      fixture.getPath('_legacy.scss'),
    ]);
    expect(edges.map((edge) => edge.statement.kind)).toEqual(['use', 'forward', 'import']);
  });

  test('ignores a reference resolved outside the target set without an edge or a diagnostic', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        @use './outside';
      `,
      '_outside.scss': dedent`
        $x: 1;
      `,
    });
    // Only "consumer.module.scss" is in the target set: "_outside.scss" is out of glob range.
    const parsedFiles = await parsedFilesOf(fixture, ['consumer.module.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(diagnostics).toEqual([]);
    expect(graph.edges.size).toBe(0);
  });

  test('reports a diagnostic with position for a specifier that cannot be resolved', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        $x: 1;
        @use './missing';
      `,
    });
    const parsedFiles = await parsedFilesOf(fixture, ['consumer.module.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(graph.edges.size).toBe(0);
    expect(diagnostics).toEqual([
      {
        file: fixture.getPath('consumer.module.scss'),
        line: 2,
        column: 1,
        syntax: '@use',
        message: 'cannot resolve import "./missing"',
        hint: "The bundler may resolve this specifier via a load path or alias; pass --load-path or --alias to reproduce the bundler's configuration.",
      },
    ]);
  });

  test('ignores a reference resolved into node_modules without an edge or a diagnostic', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        @use 'pkg/theme';
      `,
      'node_modules': {
        pkg: {
          '_theme.scss': dedent`
            $primary: #06f;
          `,
        },
      },
    });
    const parsedFiles = await parsedFilesOf(fixture, ['consumer.module.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(diagnostics).toEqual([]);
    expect(graph.edges.size).toBe(0);
  });

  test('passes loadPaths through to resolution', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        @use 'theme';
      `,
      'styles': {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });
    const parsedFiles = await parsedFilesOf(fixture, ['consumer.module.scss', 'styles/_theme.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles, { loadPaths: [fixture.getPath('styles')] });

    expect(diagnostics).toEqual([]);
    const edges = graph.edges.get(fixture.getPath('consumer.module.scss'));
    expect.assert(edges !== undefined);
    expect(edges.map((edge) => edge.resolvedPath)).toEqual([fixture.getPath('styles/_theme.scss')]);
  });

  test('passes alias through to resolution', async () => {
    await using fixture = await createFixture({
      app: {
        'consumer.module.scss': dedent`
          @use '@/theme';
        `,
      },
      src: {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });
    const parsedFiles = await parsedFilesOf(fixture, ['app/consumer.module.scss', 'src/_theme.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles, { alias: { '@': [fixture.getPath('src')] } });

    expect(diagnostics).toEqual([]);
    const edges = graph.edges.get(fixture.getPath('app/consumer.module.scss'));
    expect.assert(edges !== undefined);
    expect(edges.map((edge) => edge.resolvedPath)).toEqual([fixture.getPath('src/_theme.scss')]);
  });

  test('builds an edge to the partial when both theme.scss and _theme.scss exist', async () => {
    await using fixture = await createFixture({
      'consumer.module.scss': dedent`
        @use './theme';
      `,
      'theme.scss': '',
      '_theme.scss': '',
    });
    const parsedFiles = await parsedFilesOf(fixture, ['consumer.module.scss', 'theme.scss', '_theme.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(diagnostics).toEqual([]);
    const edges = graph.edges.get(fixture.getPath('consumer.module.scss'));
    expect.assert(edges !== undefined);
    expect(edges.map((edge) => edge.resolvedPath)).toEqual([fixture.getPath('_theme.scss')]);
  });
});

describe('importersOf', () => {
  test('returns files that import the given file', async () => {
    await using fixture = await createFixture({
      'a.module.scss': dedent`
        @use './theme';
      `,
      'b.module.scss': dedent`
        @use './theme';
      `,
      '_theme.scss': dedent`
        $primary: #06f;
      `,
    });
    const parsedFiles = await parsedFilesOf(fixture, ['a.module.scss', 'b.module.scss', '_theme.scss']);

    const { graph, diagnostics } = buildModuleGraph(parsedFiles);

    expect(diagnostics).toEqual([]);
    expect(importersOf(graph, fixture.getPath('_theme.scss')).sort()).toEqual(
      [fixture.getPath('a.module.scss'), fixture.getPath('b.module.scss')].sort(),
    );
    expect(importersOf(graph, fixture.getPath('a.module.scss'))).toEqual([]);
  });
});
