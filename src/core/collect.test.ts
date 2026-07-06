import dedent from 'dedent';
import { createFixture } from 'fs-fixture';
import { expect, test } from 'vite-plus/test';
import { collectFiles } from './collect.ts';

test('collects files matching a glob pattern as absolute paths', async () => {
  await using fixture = await createFixture({
    'a.module.scss': dedent`
      .a { color: red; }
    `,
    'b.module.scss': '',
    'c.txt': '',
  });

  const files = await collectFiles(['**/*.module.scss'], { cwd: fixture.path });

  expect(files).toEqual([fixture.getPath('a.module.scss'), fixture.getPath('b.module.scss')]);
});

test('merges results from multiple patterns without duplicates, sorted', async () => {
  await using fixture = await createFixture({
    'a.module.scss': '',
    'b.module.scss': '',
    '_partial.scss': dedent`
      $color: red;
    `,
  });

  const files = await collectFiles(['**/*.module.scss', '**/*.scss'], { cwd: fixture.path });

  expect(files).toEqual([
    fixture.getPath('_partial.scss'),
    fixture.getPath('a.module.scss'),
    fixture.getPath('b.module.scss'),
  ]);
});

test('excludes files matching an exclude pattern', async () => {
  await using fixture = await createFixture({
    'a.module.scss': '',
    'b.module.scss': '',
    'vendor': {
      'c.module.scss': '',
    },
    'legacy': {
      'd.module.scss': '',
    },
  });

  const files = await collectFiles(['**/*.module.scss'], {
    cwd: fixture.path,
    exclude: ['**/vendor/**', '**/legacy/**'],
  });

  expect(files).toEqual([fixture.getPath('a.module.scss'), fixture.getPath('b.module.scss')]);
});

test('always excludes node_modules even when an exclude option is given', async () => {
  await using fixture = await createFixture({
    'a.module.scss': '',
    'node_modules': {
      'some-pkg': {
        'b.module.scss': '',
      },
    },
  });

  const files = await collectFiles(['**/*.module.scss'], {
    cwd: fixture.path,
    exclude: ['**/vendor/**'],
  });

  expect(files).toEqual([fixture.getPath('a.module.scss')]);
});

test('excludes node_modules even without an exclude option', async () => {
  await using fixture = await createFixture({
    'a.module.scss': '',
    'node_modules': {
      'some-pkg': {
        'b.module.scss': '',
      },
    },
  });

  const files = await collectFiles(['**/*.module.scss'], { cwd: fixture.path });

  expect(files).toEqual([fixture.getPath('a.module.scss')]);
});

test('returns an empty array when no file matches', async () => {
  await using fixture = await createFixture({
    'a.txt': '',
  });

  const files = await collectFiles(['**/*.module.scss'], { cwd: fixture.path });

  expect(files).toEqual([]);
});

test('returns only files even when a pattern matches a directory', async () => {
  await using fixture = await createFixture({
    'a.module.scss': '',
    'dir.module.scss': {
      'e.module.scss': '',
    },
  });

  const files = await collectFiles(['**/*.module.scss'], { cwd: fixture.path });

  expect(files).toEqual([fixture.getPath('a.module.scss'), fixture.getPath('dir.module.scss/e.module.scss')]);
});
