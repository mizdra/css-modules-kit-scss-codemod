import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { collectFiles } from "./collect.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collect-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(relativePath: string): void {
  const absolutePath = join(dir, relativePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, "");
}

test("glob パターンに一致するファイルを絶対パスで収集する", async () => {
  writeFixture("a.module.scss");
  writeFixture("b.module.scss");
  writeFixture("c.txt");

  const files = await collectFiles(["**/*.module.scss"], { cwd: dir });

  expect(files).toEqual([join(dir, "a.module.scss"), join(dir, "b.module.scss")]);
});

test("複数パターンの結果をマージして重複なくソート順で返す", async () => {
  writeFixture("a.module.scss");
  writeFixture("b.module.scss");
  writeFixture("_partial.scss");

  const files = await collectFiles(["**/*.module.scss", "**/*.scss"], { cwd: dir });

  expect(files).toEqual([
    join(dir, "_partial.scss"),
    join(dir, "a.module.scss"),
    join(dir, "b.module.scss"),
  ]);
});

test("exclude パターンに一致するファイルを除外する", async () => {
  writeFixture("a.module.scss");
  writeFixture("b.module.scss");
  writeFixture("vendor/c.module.scss");
  writeFixture("legacy/d.module.scss");

  const files = await collectFiles(["**/*.module.scss"], {
    cwd: dir,
    exclude: ["**/vendor/**", "**/legacy/**"],
  });

  expect(files).toEqual([join(dir, "a.module.scss"), join(dir, "b.module.scss")]);
});

test("node_modules 配下のファイルは glob に一致しても常に除外する", async () => {
  writeFixture("a.module.scss");
  writeFixture("node_modules/some-pkg/b.module.scss");

  const files = await collectFiles(["**/*.module.scss"], { cwd: dir });

  expect(files).toEqual([join(dir, "a.module.scss")]);
});

test("一致するファイルがないとき空配列を返す", async () => {
  writeFixture("a.txt");

  const files = await collectFiles(["**/*.module.scss"], { cwd: dir });

  expect(files).toEqual([]);
});
