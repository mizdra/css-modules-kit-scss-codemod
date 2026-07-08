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

describe('analyze', () => {
  test('analyzes a clean project and exits 0', async () => {
    await using fixture = await createFixture({
      src: {
        'button.module.scss': dedent`
          @use './theme' as t;
          .button {
            color: t.$primary;
          }
        `,
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('prints file counts, module graph, and partial classification', async () => {
    await using fixture = await createFixture({
      src: {
        'button.module.scss': dedent`
          @use './theme' as t;
          .button {
            color: t.$primary;
          }
        `,
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Analyzed 2 files (1 roots, 1 partials)');
    expect(result.stdout).toContain('src/button.module.scss');
    expect(result.stdout).toContain('→ src/_theme.scss (@use "./theme")');
    expect(result.stdout).toContain('src/_theme.scss: definition-only');
  });

  test('reports stage applicability with safety labels', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          // silent comment
          .a { color: red; }
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Stage applicability:');
    expect(result.stdout).toContain('comments (constructively equivalent, M0): 1 files — src/a.module.scss');
  });

  test('exits 1 and reports unsupported syntax with position', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a {
            @extend .b;
          }
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Problems:');
    expect(result.stdout).toContain('src/a.module.scss:2:3');
    expect(result.stdout).toContain('@extend');
    expect(result.stdout).toMatch(/Summary: \d+ errors?/u);
  });

  test('exits 1 when a file fails to parse', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red;
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Problems:');
    expect(result.stdout).toContain('src/a.module.scss');
  });

  test('exits 1 for an unresolved import', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          @use './missing';
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('cannot resolve import "./missing"');
  });

  test('exits 1 for a mixed partial', async () => {
    await using fixture = await createFixture({
      src: {
        '_legacy.scss': dedent`
          $primary: #06f;
          .a { color: red; }
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('src/_legacy.scss: mixed (error)');
    expect(result.stdout).toContain('mixed partial');
  });

  test('exits 1 when a root file fails to compile', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a {
            color: $missing;
          }
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Uncompilable files:');
    expect(result.stdout).toContain('src/a.module.scss');
    expect(result.stdout).toContain('Undefined variable.');
  });

  test('treats convertible findings as informational and exits 0', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          // note
          .a { color: red; }
        `,
      },
    });

    const result = await run(['analyze', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Problems:');
    expect(result.stdout).toContain('comments');
    expect(result.stdout).toContain('Summary: no errors');
  });

  test('outputs machine-readable JSON with --json', async () => {
    await using fixture = await createFixture({
      src: {
        'button.module.scss': dedent`
          @use './theme' as t;
          .button {
            color: t.$primary;
          }
        `,
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
    });

    const result = await run(['analyze', '--json', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      files: {
        path: string;
        role: string;
        compiles?: boolean;
        partialClassification?: string;
        imports: { kind: string; specifier: string; resolvedPath: string }[];
        convertible: { stage: string; syntax: string }[];
      }[];
      diagnostics: unknown[];
      summary: {
        fileCount: number;
        rootCount: number;
        partialCount: number;
        errorCount: number;
        stages: Record<string, string[]>;
      };
    };

    expect(output.diagnostics).toEqual([]);
    expect(output.summary).toEqual({
      fileCount: 2,
      rootCount: 1,
      partialCount: 1,
      errorCount: 0,
      stages: { modules: ['src/button.module.scss'] },
    });

    const button = output.files.find((file) => file.path === 'src/button.module.scss');
    expect.assert(button !== undefined);
    expect(button.role).toBe('root');
    expect(button.compiles).toBe(true);
    expect(button.imports).toEqual([
      { kind: 'use', specifier: './theme', resolvedPath: 'src/_theme.scss', line: 1, column: 1 },
    ]);
    expect(button.convertible.map((c) => c.stage)).toEqual(['modules', 'modules']);

    const theme = output.files.find((file) => file.path === 'src/_theme.scss');
    expect.assert(theme !== undefined);
    expect(theme.role).toBe('partial');
    expect(theme.partialClassification).toBe('definition-only');
    expect(theme.imports).toEqual([]);
    expect(theme.convertible).toEqual([]);
    expect(theme.compiles).toBeUndefined();
  });

  test('excludes files matched by --exclude', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
        'b.module.scss': dedent`
          .b { color: blue; }
        `,
      },
    });

    const result = await run(['analyze', '--exclude', 'src/b.module.scss', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Analyzed 1 files (1 roots, 0 partials)');
    expect(result.stdout).not.toContain('b.module.scss');
  });

  test('exits 2 when no file matches the patterns', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['analyze', 'nomatch/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no files matched');
  });

  test('exits 2 for a malformed --alias value', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
      },
    });

    const result = await run(['analyze', '--alias', 'no-equals-sign', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('invalid --alias "no-equals-sign"');
  });

  test('honors --load-path and --alias end to end', async () => {
    await using fixture = await createFixture({
      app: {
        'consumer.module.scss': dedent`
          @use '@/theme' as t;
          .a { color: t.$primary; }
        `,
      },
      src: {
        '_theme.scss': dedent`
          $primary: #06f;
        `,
      },
      other: {
        'vendor.module.scss': dedent`
          @use 'vendor-theme' as t;
          .a { color: t.$primary; }
        `,
      },
      vendor: {
        '_vendor-theme.scss': dedent`
          $primary: #f06;
        `,
      },
    });

    const result = await run(
      ['analyze', '--alias', '@=src', '--load-path', 'vendor', 'app/**/*.scss', 'other/**/*.scss'],
      fixture.path,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Uncompilable files: none');
  });
});
