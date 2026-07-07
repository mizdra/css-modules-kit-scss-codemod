import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import dedent from 'dedent';
import { createFixture } from 'fs-fixture';
import { describe, expect, test } from 'vite-plus/test';
import { runCli } from '../index.ts';

function captureStream() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return {
    stream,
    get output() {
      return Buffer.concat(chunks).toString();
    },
  };
}

async function run(argv: string[], cwd: string) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runCli(argv, { stdout: stdout.stream, stderr: stderr.stream, cwd });
  return { exitCode, stdout: stdout.output, stderr: stderr.output };
}

describe('convert comments', () => {
  test('converts silent comments to loud comments across multiple files', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          // note a
          .a { color: red; }
        `,
        'b.module.scss': dedent`
          .b {
            // note b
            color: blue;
          }
        `,
      },
    });

    const result = await run(['convert', 'comments', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('comments: converted 2 files (0 unchanged)');

    await expect(readFile(fixture.getPath('src/a.module.scss'), 'utf8')).resolves.toBe(dedent`
      /* note a */
      .a { color: red; }
    `);
    await expect(readFile(fixture.getPath('src/b.module.scss'), 'utf8')).resolves.toBe(dedent`
      .b {
        /* note b */
        color: blue;
      }
    `);
  });

  test('leaves a file untouched when it has no silent comments to convert', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          /* already loud */
          .a { color: red; }
        `,
      },
    });
    const originalContent = await readFile(fixture.getPath('src/a.module.scss'), 'utf8');

    const result = await run(['convert', 'comments', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('comments: converted 1 files (1 unchanged)');
    await expect(readFile(fixture.getPath('src/a.module.scss'), 'utf8')).resolves.toBe(originalContent);
  });

  test('writes nothing when one file in the target set fails to parse', async () => {
    await using fixture = await createFixture({
      src: {
        'ok.module.scss': dedent`
          // convertible
          .a { color: red; }
        `,
        'broken.module.scss': dedent`
          .b { color: red;
        `,
      },
    });
    const originalOk = await readFile(fixture.getPath('src/ok.module.scss'), 'utf8');
    const originalBroken = await readFile(fixture.getPath('src/broken.module.scss'), 'utf8');

    const result = await run(['convert', 'comments', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/broken.module.scss');
    await expect(readFile(fixture.getPath('src/ok.module.scss'), 'utf8')).resolves.toBe(originalOk);
    await expect(readFile(fixture.getPath('src/broken.module.scss'), 'utf8')).resolves.toBe(originalBroken);
  });

  test('is idempotent: a second run reports every file as unchanged', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          // note
          .a { color: red; }
        `,
      },
    });

    const first = await run(['convert', 'comments', 'src/**/*.scss'], fixture.path);
    const second = await run(['convert', 'comments', 'src/**/*.scss'], fixture.path);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('comments: converted 1 files (0 unchanged)');
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('comments: converted 1 files (1 unchanged)');
  });

  test('exits 1 for a stage without an implemented transform yet', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['convert', 'expressions', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('planned for M1');
    await expect(readFile(fixture.getPath('src/a.module.scss'), 'utf8')).resolves.toBe(dedent`
      .a { color: red; }
    `);
  });

  test('exits 2 when no file matches the patterns', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['convert', 'comments', 'nomatch/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no files matched');
  });
});
