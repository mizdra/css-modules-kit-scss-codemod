<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Commands

- `vp install` — install dependencies (pnpm-based)
- `vp check` — format, lint (oxlint with type-aware rules), and type check
- `vp test` — run all tests (Vitest); run a single file with `vp test run src/core/parse.test.ts`, filter by name with `-t <pattern>`
- `vp run build` — build `dist/` via `vp pack` (entries: `src/index.ts` public API, `src/cli.ts` bin-only)

# Architecture

`@css-modules-kit/scss-codemod` is a one-shot CLI codemod that converts `.module.scss` to `.module.css` in a "PostCSS dialect" — CSS processable by postcss-mixins → postcss-simple-vars → postcss-nested. The authoritative spec is `docs/scss-to-css-migration-tool-design.md` (Japanese); code comments reference its section numbers (§). Consult it before changing behavior, and update its M0 checklist (§13.2) when completing implementation steps.

Design principles that shape all code (design doc §3):

- **Whitelist / fail-closed**: only syntax listed in the design doc §6 table is converted. Everything else — even seemingly harmless constructs — must error (and become a `todo` item), never pass through silently.
- **Staged conversion**: conversion runs one stage at a time (`comments`, `at-statements`, `expressions`, `colors`, `modules`, `mixins`, `interpolation`, `to-css`) across a glob-selected file set. The stage table (name × milestone × safety) lives in `src/stages.ts`.
- **Project-level atomicity**: `convert` parses and transforms every target file in memory first; a single failure anywhere (parse, precondition, transform) blocks all writes. `src/core/write.ts` writes via same-directory temp files with best-effort rollback.
- **Idempotency**: every stage transform must be a no-op when reapplied to its own output.

Layers:

- `src/cli.ts` is a bin shim; `src/index.ts` exposes `runCli(argv, io)` — command dispatch with `node:util` parseArgs, exit codes 0 = success / 1 = failure or not-implemented / 2 = usage error. `CliIo` (`src/io.ts`) carries writable streams + cwd so tests run the CLI in-process without spawning.
- `src/commands/` — `analyze` (syntax classification, module graph, partial classification, compile check), `convert` (stage application; implemented transforms are registered in the `TRANSFORMS` map in `convert.ts`), `todo` (markdown/JSON report of unconvertible constructs with hints). `verify` is planned for M1.
- `src/core/` — shared analysis: `parse` (postcss-scss wrapper, preserves raws for formatting), `classify` (the whitelist judgment; values via postcss-value-parser, unknown function names checked against css-functions-list + Sass builtins), `resolve`/`module-graph` (sass-loader-style specifier resolution via oxc-resolver: partial `_` expansion is hand-rolled, the rest is resolver config), `partial` (definition-only / style-emitting / mixed classification), `sass-compile` (dart-sass sanity check), `diagnostic` (the `Diagnostic` type + human/JSON formatting), `write` (atomic writes).
- `src/stages/` — one `StageTransform` per stage (`types.ts`): mutates the postcss `Root` in place and returns `diagnostics` (block the whole run) and `logs` (informational, e.g. removed `@warn` content).

# Conventions

- Write pull request titles and descriptions in English.
- Write test case names and code comments in English.
