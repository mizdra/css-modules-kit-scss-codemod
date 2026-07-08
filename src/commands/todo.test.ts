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

describe('todo', () => {
  test('lists unsupported syntax as a markdown prompt with positions, labels, and hints', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a {
            @extend .b;
          }
          $colors: (a: 1, b: 2);
          .c {
            width: my-func(1px);
          }
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('## src/a.module.scss');
    expect(result.stdout).toContain('**L2:3** `@extend`');
    expect(result.stdout).toContain('(no support planned)');
    expect(result.stdout).toContain('hint: Rewrite manually with `composes`');
    expect(result.stdout).toContain('`map/list value`');
    expect(result.stdout).toContain('`unknown function "my-func()"`');
    expect(result.stdout).toContain('hint: If this is a plain CSS function, please report it');
    expect(result.stdout).toContain('scss-codemod convert <stage> src/**/*.scss');
    expect(result.stdout).toContain('scss-codemod verify src/**/*.scss');
  });

  test('supplies a default hint for syntax classify does not already hint', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          @each $i in 1, 2, 3 {
            .a-#{$i} { width: $i; }
          }
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('`@each`');
    expect(result.stdout).toMatch(/@each`[^\n]*\n\s*hint: /u);
  });

  test('excludes convert-only findings and reports no manual work', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          // silent comment
          @use './theme' as t;
          @warn 'heads up';
          .a { color: t.$primary; }
        `,
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No manual work found.\n');
  });

  test('flags a mixed partial as manual work', async () => {
    await using fixture = await createFixture({
      src: {
        '_mixed.scss': dedent`
          $primary: #06f;
          .a { color: $primary; }
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('## src/_mixed.scss');
    expect(result.stdout).toContain('mixed partial');
    expect(result.stdout).toContain('Split the file into a definition-only partial');
  });

  test('flags a file that fails to parse', async () => {
    await using fixture = await createFixture({
      src: {
        'broken.module.scss': dedent`
          .a { color: red;
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('## src/broken.module.scss');
  });

  test('outputs machine-readable JSON with --json', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a {
            @extend .b;
          }
        `,
        'b.module.scss': dedent`
          .b { color: red; }
        `,
      },
    });

    const result = await run(['todo', '--json', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout) as {
      todos: { file: string; syntax?: string; line?: number; column?: number; message: string; hint?: string }[];
      summary: { todoCount: number; fileCount: number };
    };

    expect(output.summary).toEqual({ todoCount: 1, fileCount: 1 });
    expect(output.todos).toEqual([
      expect.objectContaining({ file: 'src/a.module.scss', syntax: '@extend', line: 2, column: 3 }),
    ]);
  });

  test('reports zero todos in JSON with exit 0 when nothing needs manual work', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['todo', '--json', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { todos: unknown[]; summary: { todoCount: number; fileCount: number } };
    expect(output.todos).toEqual([]);
    expect(output.summary).toEqual({ todoCount: 0, fileCount: 0 });
  });

  test('exits 2 when no file matches the patterns', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['todo', 'nomatch/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no files matched');
  });

  test('orders multiple files by relative path for deterministic output', async () => {
    await using fixture = await createFixture({
      src: {
        'z.module.scss': dedent`
          .z { @extend .base; }
        `,
        'a.module.scss': dedent`
          .a { @extend .base; }
        `,
      },
    });

    const result = await run(['todo', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    const aIndex = result.stdout.indexOf('## src/a.module.scss');
    const zIndex = result.stdout.indexOf('## src/z.module.scss');
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(zIndex).toBeGreaterThan(aIndex);
  });
});
