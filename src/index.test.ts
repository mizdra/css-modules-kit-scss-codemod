import { Writable } from "node:stream";
import { expect, test } from "vite-plus/test";
import { runCli } from "./index.ts";

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

async function run(argv: string[]) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runCli(argv, { stdout: stdout.stream, stderr: stderr.stream });
  return { exitCode, stdout: stdout.output, stderr: stderr.output };
}

test("引数なしのとき使い方エラーを返す", async () => {
  const result = await run([]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Usage: scss-codemod");
});

test("--help を渡すと使い方を表示する", async () => {
  const result = await run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("scss-codemod analyze <patterns...>");
  expect(result.stdout).toContain("scss-codemod convert <stage> <patterns...>");
  expect(result.stdout).toContain("scss-codemod verify <patterns...>");
  expect(result.stdout).toContain("scss-codemod todo <patterns...>");
});

test("未知のコマンドのとき使い方エラーを返す", async () => {
  const result = await run(["foo"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("unknown command");
  expect(result.stderr).toContain("foo");
});

test("patterns 未指定の analyze で使い方エラーを返す", async () => {
  const result = await run(["analyze"]);
  expect(result.exitCode).toBe(2);
});

test("analyze はまだ未実装であることを返す", async () => {
  const result = await run(["analyze", "**/*.module.scss"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("analyze は --json と複数の --exclude を受理する", async () => {
  const result = await run([
    "analyze",
    "--json",
    "--exclude",
    "a/**",
    "--exclude",
    "b/**",
    "src/**/*.scss",
  ]);
  expect(result.exitCode).toBe(1);
});

test("stage 未指定の convert で使い方エラーを返す", async () => {
  const result = await run(["convert"]);
  expect(result.exitCode).toBe(2);
});

test("未知の stage の convert で有効な stage 一覧つきの使い方エラーを返す", async () => {
  const result = await run(["convert", "unknown-stage", "x"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("comments");
  expect(result.stderr).toContain("to-css");
});

test("patterns 未指定の convert で使い方エラーを返す", async () => {
  const result = await run(["convert", "comments"]);
  expect(result.exitCode).toBe(2);
});

test("convert comments はまだ未実装であることを返す", async () => {
  const result = await run(["convert", "comments", "src/**/*.scss"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("convert expressions は M1 対応予定であることを返す", async () => {
  const result = await run(["convert", "expressions", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M1");
});

test("convert mixins は M2 対応予定であることを返す", async () => {
  const result = await run(["convert", "mixins", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M2");
});

test("convert に --json を渡すと使い方エラーを返す", async () => {
  const result = await run(["convert", "--json", "comments", "x"]);
  expect(result.exitCode).toBe(2);
});

test("verify は M1 対応予定であることを返す", async () => {
  const result = await run(["verify", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M1");
});

test("todo はまだ未実装であることを返す", async () => {
  const result = await run(["todo", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("todo は --json オプションを受理する", async () => {
  const result = await run(["todo", "--json", "x"]);
  expect(result.exitCode).toBe(1);
});
