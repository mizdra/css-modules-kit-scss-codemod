export const USAGE = `Usage: scss-codemod <command> [options]

Commands:
  scss-codemod analyze <patterns...> [--exclude <pattern>...] [--json]
  scss-codemod convert <stage> <patterns...> [--exclude <pattern>...]
  scss-codemod verify <patterns...> [--exclude <pattern>...] [--against <git-rev>]
  scss-codemod todo <patterns...> [--exclude <pattern>...] [--json]

Options:
  -h, --help              Show this help message
  --exclude <pattern>     Exclude files matching pattern (repeatable)
  --json                  Output machine-readable JSON (analyze, todo)
  --against <git-rev>     Git revision to compare against (verify)
`;
