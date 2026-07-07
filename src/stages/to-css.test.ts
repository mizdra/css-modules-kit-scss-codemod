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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

describe('convert to-css', () => {
  test('renames matching scss files and rewrites ts/js import specifiers', async () => {
    await using fixture = await createFixture({
      src: {
        '_theme.scss': dedent`
          $primary: #0066ff;
        `,
        'button.module.scss': dedent`
          @import './theme.css';
          @define-mixin focus {
            outline: 2px solid $primary;
          }
          .btn {
            color: $primary;
            @mixin focus;
            &:hover {
              color: darkblue;
            }
          }
        `,
        'Button.tsx': dedent`
          import styles from './button.module.scss';
          export const Button = () => styles.btn;
        `,
      },
    });

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('renamed 2 files, rewrote imports in 1 file');
    expect(result.stdout).toContain('postcss-mixins');
    expect(result.stdout).toContain('postcss-simple-vars');
    expect(result.stdout).toContain('postcss-nested');
    expect(result.stdout).toContain('verify');

    expect(await exists(fixture.getPath('src/_theme.scss'))).toBe(false);
    expect(await exists(fixture.getPath('src/button.module.scss'))).toBe(false);

    await expect(readFile(fixture.getPath('src/theme.css'), 'utf8')).resolves.toBe(dedent`
      $primary: #0066ff;
    `);
    await expect(readFile(fixture.getPath('src/button.module.css'), 'utf8')).resolves.toBe(dedent`
      @import './theme.css';
      @define-mixin focus {
        outline: 2px solid $primary;
      }
      .btn {
        color: $primary;
        @mixin focus;
        &:hover {
          color: darkblue;
        }
      }
    `);
    await expect(readFile(fixture.getPath('src/Button.tsx'), 'utf8')).resolves.toBe(dedent`
      import styles from './button.module.css';
      export const Button = () => styles.btn;
    `);
  });

  test('fails the whole run and writes nothing when a target file fails the dialect precondition', async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          @use './theme';
          .a { color: red; }
        `,
        'A.tsx': dedent`
          import styles from './a.module.scss';
        `,
      },
    });
    const originalScss = await readFile(fixture.getPath('src/a.module.scss'), 'utf8');
    const originalTsx = await readFile(fixture.getPath('src/A.tsx'), 'utf8');

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/a.module.scss');
    await expect(readFile(fixture.getPath('src/a.module.scss'), 'utf8')).resolves.toBe(originalScss);
    await expect(readFile(fixture.getPath('src/A.tsx'), 'utf8')).resolves.toBe(originalTsx);
  });

  test('fails and renames nothing when two target files would rename to the same path', async () => {
    await using fixture = await createFixture({
      src: {
        '_x.scss': dedent`
          $foo: 1px;
        `,
        'x.scss': dedent`
          .a { width: 1px; }
        `,
      },
    });

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(await exists(fixture.getPath('src/_x.scss'))).toBe(true);
    expect(await exists(fixture.getPath('src/x.scss'))).toBe(true);
    expect(await exists(fixture.getPath('src/x.css'))).toBe(false);
  });

  test('fails and changes nothing when the rename target already exists on disk', async () => {
    await using fixture = await createFixture({
      src: {
        'x.scss': dedent`
          .a { width: 1px; }
        `,
        'x.css': dedent`
          .pre-existing { color: red; }
        `,
      },
    });
    const originalCss = await readFile(fixture.getPath('src/x.css'), 'utf8');

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(await exists(fixture.getPath('src/x.scss'))).toBe(true);
    await expect(readFile(fixture.getPath('src/x.css'), 'utf8')).resolves.toBe(originalCss);
  });

  test('fails and rewrites nothing when a bare import specifier ends in .scss', async () => {
    await using fixture = await createFixture({
      src: {
        'button.module.scss': dedent`
          .btn { color: red; }
        `,
        'Component.tsx': dedent`
          import styles from '@styles/button.module.scss';
        `,
      },
    });
    const originalTsx = await readFile(fixture.getPath('src/Component.tsx'), 'utf8');

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('@styles/button.module.scss');
    expect(result.stderr.toLowerCase()).toContain('hint');
    expect(await exists(fixture.getPath('src/button.module.scss'))).toBe(true);
    expect(await exists(fixture.getPath('src/button.module.css'))).toBe(false);
    await expect(readFile(fixture.getPath('src/Component.tsx'), 'utf8')).resolves.toBe(originalTsx);
  });

  test('leaves an import specifier untouched when it points outside the target glob', async () => {
    await using fixture = await createFixture({
      src: {
        a: {
          'foo.module.scss': dedent`
            .foo { color: red; }
          `,
          'Foo.tsx': dedent`
            import other from '../b/other.module.scss';
            import styles from './foo.module.scss';
          `,
        },
        b: {
          'other.module.scss': dedent`
            .other { color: blue; }
          `,
        },
      },
    });

    const result = await run(['convert', 'to-css', 'src/a/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(await exists(fixture.getPath('src/b/other.module.scss'))).toBe(true);
    await expect(readFile(fixture.getPath('src/a/Foo.tsx'), 'utf8')).resolves.toBe(dedent`
      import other from '../b/other.module.scss';
      import styles from './foo.module.css';
    `);
  });

  test('preserves a ?query suffix on a rewritten import specifier', async () => {
    await using fixture = await createFixture({
      src: {
        'button.module.scss': dedent`
          .btn { color: red; }
        `,
        'Button.tsx': dedent`
          import styles from './button.module.scss?inline';
        `,
      },
    });

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    await expect(readFile(fixture.getPath('src/Button.tsx'), 'utf8')).resolves.toBe(dedent`
      import styles from './button.module.css?inline';
    `);
  });

  test("preserves each import specifier's own quote style after rewriting", async () => {
    await using fixture = await createFixture({
      src: {
        'a.module.scss': dedent`
          .a { color: red; }
        `,
        'b.module.scss': dedent`
          .b { color: blue; }
        `,
        'Single.tsx': dedent`
          import a from './a.module.scss';
        `,
        'Double.tsx': dedent`
          import b from "./b.module.scss";
        `,
      },
    });

    const result = await run(['convert', 'to-css', 'src/**/*.scss'], fixture.path);

    expect(result.exitCode).toBe(0);
    await expect(readFile(fixture.getPath('src/Single.tsx'), 'utf8')).resolves.toBe(dedent`
      import a from './a.module.css';
    `);
    await expect(readFile(fixture.getPath('src/Double.tsx'), 'utf8')).resolves.toBe(dedent`
      import b from "./b.module.css";
    `);
  });
});
