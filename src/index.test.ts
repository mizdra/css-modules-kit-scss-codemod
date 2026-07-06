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

test("returns a usage error when given no arguments", async () => {
  const result = await run([]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Usage: scss-codemod");
});

test("shows usage when given --help", async () => {
  const result = await run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("scss-codemod analyze <patterns...>");
  expect(result.stdout).toContain("scss-codemod convert <stage> <patterns...>");
  expect(result.stdout).toContain("scss-codemod verify <patterns...>");
  expect(result.stdout).toContain("scss-codemod todo <patterns...>");
});

test("returns a usage error for an unknown command", async () => {
  const result = await run(["foo"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("unknown command");
  expect(result.stderr).toContain("foo");
});

test("returns a usage error when analyze is given no patterns", async () => {
  const result = await run(["analyze"]);
  expect(result.exitCode).toBe(2);
});

test("returns not implemented for analyze", async () => {
  const result = await run(["analyze", "**/*.module.scss"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("accepts --json and multiple --exclude on analyze", async () => {
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

test("returns a usage error when convert is given no stage", async () => {
  const result = await run(["convert"]);
  expect(result.exitCode).toBe(2);
});

test("returns a usage error listing valid stages for an unknown convert stage", async () => {
  const result = await run(["convert", "unknown-stage", "x"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("comments");
  expect(result.stderr).toContain("to-css");
});

test("returns a usage error when convert is given no patterns", async () => {
  const result = await run(["convert", "comments"]);
  expect(result.exitCode).toBe(2);
});

test("returns not implemented for convert comments", async () => {
  const result = await run(["convert", "comments", "src/**/*.scss"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("returns M1 planned for convert expressions", async () => {
  const result = await run(["convert", "expressions", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M1");
});

test("returns M2 planned for convert mixins", async () => {
  const result = await run(["convert", "mixins", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M2");
});

test("returns a usage error when convert is given --json", async () => {
  const result = await run(["convert", "--json", "comments", "x"]);
  expect(result.exitCode).toBe(2);
});

test("returns M1 planned for verify", async () => {
  const result = await run(["verify", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("M1");
});

test("returns not implemented for todo", async () => {
  const result = await run(["todo", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("not implemented");
});

test("accepts a --json option on todo", async () => {
  const result = await run(["todo", "--json", "x"]);
  expect(result.exitCode).toBe(1);
});
