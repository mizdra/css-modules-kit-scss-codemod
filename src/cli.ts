#!/usr/bin/env node
import { runCli } from "./index.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
