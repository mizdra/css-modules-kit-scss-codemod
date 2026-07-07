import { chmod, readFile, readdir } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { createFixture } from 'fs-fixture';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { writeFilesAtomically } from './write.ts';

// Lets a specific test force `rename` to fail for one target path, so the commit-phase
// rollback path (a real filesystem failure mode that's otherwise hard to trigger
// deterministically and cross-platform) can be exercised. All other calls (and all other fs
// functions) pass through to the real implementation untouched.
let renameFailureTarget: string | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      if (renameFailureTarget !== undefined && newPath === renameFailureTarget) {
        throw new Error('Simulated rename failure');
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

afterEach(() => {
  renameFailureTarget = undefined;
});

describe('writeFilesAtomically', () => {
  test('replaces every target file with its new content', async () => {
    await using fixture = await createFixture({
      'a.scss': 'old-a',
      'b.scss': 'old-b',
    });

    const result = await writeFilesAtomically([
      { path: fixture.getPath('a.scss'), content: 'new-a' },
      { path: fixture.getPath('b.scss'), content: 'new-b' },
    ]);

    expect(result).toEqual({ ok: true });
    await expect(readFile(fixture.getPath('a.scss'), 'utf8')).resolves.toBe('new-a');
    await expect(readFile(fixture.getPath('b.scss'), 'utf8')).resolves.toBe('new-b');
  });

  test('succeeds without touching the filesystem when writes is empty', async () => {
    const result = await writeFilesAtomically([]);

    expect(result).toEqual({ ok: true });
  });

  test('fails and leaves existing targets untouched when a target file does not exist', async () => {
    await using fixture = await createFixture({
      'a.scss': 'old-a',
    });

    const result = await writeFilesAtomically([
      { path: fixture.getPath('a.scss'), content: 'new-a' },
      { path: fixture.getPath('missing.scss'), content: 'new-missing' },
    ]);

    expect(result.ok).toBe(false);
    expect.assert(!result.ok);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.file).toBe(fixture.getPath('missing.scss'));
    await expect(readFile(fixture.getPath('a.scss'), 'utf8')).resolves.toBe('old-a');
  });

  test('fails and leaves existing targets untouched when the prepare phase cannot create a temp file', async () => {
    await using fixture = await createFixture({
      sub: { 'protected.scss': 'old-protected' },
    });
    const dir = fixture.getPath('sub');
    await chmod(dir, 0o555); // read + execute only: existing files stay readable, new files can't be created
    try {
      const result = await writeFilesAtomically([
        { path: fixture.getPath('sub/protected.scss'), content: 'new-protected' },
      ]);

      expect(result.ok).toBe(false);
      await expect(readFile(fixture.getPath('sub/protected.scss'), 'utf8')).resolves.toBe('old-protected');
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test('rolls back an already-replaced file when a later rename fails', async () => {
    await using fixture = await createFixture({
      'a.scss': 'old-a',
      'b.scss': 'old-b',
    });
    renameFailureTarget = fixture.getPath('b.scss');

    const result = await writeFilesAtomically([
      { path: fixture.getPath('a.scss'), content: 'new-a' },
      { path: fixture.getPath('b.scss'), content: 'new-b' },
    ]);

    expect(result.ok).toBe(false);
    expect.assert(!result.ok);
    expect(result.diagnostics[0]?.file).toBe(fixture.getPath('b.scss'));
    await expect(readFile(fixture.getPath('a.scss'), 'utf8')).resolves.toBe('old-a');
    await expect(readFile(fixture.getPath('b.scss'), 'utf8')).resolves.toBe('old-b');
  });

  test('leaves no leftover temp files after a successful write', async () => {
    await using fixture = await createFixture({ 'a.scss': 'old-a' });

    const result = await writeFilesAtomically([{ path: fixture.getPath('a.scss'), content: 'new-a' }]);

    expect(result).toEqual({ ok: true });
    const entries = await readdir(fixture.path);
    expect(entries.sort()).toEqual(['a.scss']);
  });

  test('leaves no leftover temp files after a rollback', async () => {
    await using fixture = await createFixture({
      'a.scss': 'old-a',
      'b.scss': 'old-b',
    });
    renameFailureTarget = fixture.getPath('b.scss');

    const result = await writeFilesAtomically([
      { path: fixture.getPath('a.scss'), content: 'new-a' },
      { path: fixture.getPath('b.scss'), content: 'new-b' },
    ]);

    expect(result.ok).toBe(false);
    const entries = await readdir(fixture.path);
    expect(entries.sort()).toEqual(['a.scss', 'b.scss']);
  });

  test('succeeds when writing the same content to the same file twice', async () => {
    await using fixture = await createFixture({ 'a.scss': 'old-a' });
    const write = { path: fixture.getPath('a.scss'), content: 'new-a' };

    const first = await writeFilesAtomically([write]);
    const second = await writeFilesAtomically([write]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    await expect(readFile(fixture.getPath('a.scss'), 'utf8')).resolves.toBe('new-a');
  });
});
