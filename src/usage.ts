export const USAGE = `Usage: scss-codemod <command> [options]

Commands:
  scss-codemod analyze <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--alias <from=to>...] [--json]
  scss-codemod convert <stage> <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--alias <from=to>...]
  scss-codemod verify <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--alias <from=to>...] [--against <git-rev>]
  scss-codemod todo <patterns...> [--exclude <pattern>...] [--load-path <dir>...] [--alias <from=to>...] [--json]

Options:
  -h, --help              Show this help message
  --exclude <pattern>     Exclude files matching pattern (repeatable)
  --load-path <dir>       Add a directory to resolve imports from, like dart-sass loadPaths (repeatable)
  --alias <from=to>       Resolve specifiers starting with <from> to <to>, like bundler resolve.alias (repeatable)
  --json                  Output machine-readable JSON (analyze, todo)
  --against <git-rev>     Git revision to compare against (verify)
`;
