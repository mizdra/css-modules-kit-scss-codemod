import { expect, test } from "vite-plus/test";
import { formatDiagnostics, formatDiagnosticsAsJson } from "./diagnostic.ts";

test("全フィールドありの diagnostic を位置・構文・milestone・hint 込みで整形する", () => {
  const output = formatDiagnostics([
    {
      file: "a.module.scss",
      line: 3,
      column: 5,
      syntax: "@extend",
      milestone: "never",
      message: "`@extend` is not supported.",
      hint: "Rewrite using `composes`.",
    },
  ]);

  expect(output).toBe(
    "a.module.scss:3:5: `@extend` is not supported. [@extend, no support planned]\n  hint: Rewrite using `composes`.\n",
  );
});

test("line/column なしの diagnostic を file: message 形式で整形する", () => {
  const output = formatDiagnostics([{ file: "a.module.scss", message: "Failed to compile." }]);

  expect(output).toBe("a.module.scss: Failed to compile.\n");
});

test("milestone が never のとき no support planned と表示する", () => {
  const output = formatDiagnostics([
    {
      file: "a.module.scss",
      line: 1,
      column: 1,
      syntax: "@each",
      milestone: "never",
      message: "Control flow is not supported.",
    },
  ]);

  expect(output).toBe(
    "a.module.scss:1:1: Control flow is not supported. [@each, no support planned]\n",
  );
});

test("milestone が never 以外のとき planned: <milestone> と表示する", () => {
  const output = formatDiagnostics([
    {
      file: "a.module.scss",
      line: 1,
      column: 1,
      syntax: "map value",
      milestone: "M2",
      message: "Color functions are not supported yet.",
    },
  ]);

  expect(output).toBe(
    "a.module.scss:1:1: Color functions are not supported yet. [map value, planned: M2]\n",
  );
});

test("syntax のみ、milestone のみのとき角括弧内をそれぞれの内容だけにする", () => {
  const syntaxOnly = formatDiagnostics([
    { file: "a.module.scss", line: 1, column: 1, syntax: "@extend", message: "msg" },
  ]);
  expect(syntaxOnly).toBe("a.module.scss:1:1: msg [@extend]\n");

  const milestoneOnly = formatDiagnostics([
    { file: "a.module.scss", line: 1, column: 1, milestone: "M2", message: "msg" },
  ]);
  expect(milestoneOnly).toBe("a.module.scss:1:1: msg [planned: M2]\n");

  const milestoneOnlyNever = formatDiagnostics([
    { file: "a.module.scss", line: 1, column: 1, milestone: "never", message: "msg" },
  ]);
  expect(milestoneOnlyNever).toBe("a.module.scss:1:1: msg [no support planned]\n");
});

test("省略可能フィールドがすべてないとき message だけを整形する", () => {
  const output = formatDiagnostics([{ file: "a.module.scss", message: "Failed to compile." }]);

  expect(output).toBe("a.module.scss: Failed to compile.\n");
});

test("複数の diagnostics を改行区切りで整形する", () => {
  const output = formatDiagnostics([
    { file: "a.module.scss", line: 1, column: 1, message: "first" },
    { file: "b.module.scss", line: 2, column: 2, message: "second" },
  ]);

  expect(output).toBe("a.module.scss:1:1: first\nb.module.scss:2:2: second\n");
});

test("0 件のとき空文字列を返す", () => {
  expect(formatDiagnostics([])).toBe("");
});

test("JSON 整形で省略フィールドが出力されない", () => {
  const output = formatDiagnosticsAsJson([
    { file: "a.module.scss", message: "Failed to compile." },
  ]);

  expect(output).toBe(
    JSON.stringify([{ file: "a.module.scss", message: "Failed to compile." }], null, 2) + "\n",
  );
  expect(output).not.toContain("line");
  expect(output).not.toContain("hint");
});
