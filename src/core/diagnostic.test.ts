import { expect, test } from "vite-plus/test";
import { formatDiagnostics, formatDiagnosticsAsJson } from "./diagnostic.ts";

test("formats a diagnostic with location, syntax, milestone, and hint", () => {
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

test("formats a diagnostic without line/column as file: message", () => {
  const output = formatDiagnostics([{ file: "a.module.scss", message: "Failed to compile." }]);

  expect(output).toBe("a.module.scss: Failed to compile.\n");
});

test("shows no support planned when milestone is never", () => {
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

test("shows planned: <milestone> when milestone is not never", () => {
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

test("shows only the given field in brackets when only syntax or only milestone is set", () => {
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

test("formats only the message when all optional fields are absent", () => {
  const output = formatDiagnostics([{ file: "a.module.scss", message: "Failed to compile." }]);

  expect(output).toBe("a.module.scss: Failed to compile.\n");
});

test("formats multiple diagnostics separated by newlines", () => {
  const output = formatDiagnostics([
    { file: "a.module.scss", line: 1, column: 1, message: "first" },
    { file: "b.module.scss", line: 2, column: 2, message: "second" },
  ]);

  expect(output).toBe("a.module.scss:1:1: first\nb.module.scss:2:2: second\n");
});

test("returns an empty string when there are no diagnostics", () => {
  expect(formatDiagnostics([])).toBe("");
});

test("omits absent optional fields from JSON formatting", () => {
  const output = formatDiagnosticsAsJson([
    { file: "a.module.scss", message: "Failed to compile." },
  ]);

  expect(output).toBe(
    JSON.stringify([{ file: "a.module.scss", message: "Failed to compile." }], null, 2) + "\n",
  );
  expect(output).not.toContain("line");
  expect(output).not.toContain("hint");
});
