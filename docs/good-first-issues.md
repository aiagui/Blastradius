# Good first issues (drafts)

Drafts to open on GitHub once the repo is public. Each should get the
`good first issue` label.

1. **Add `--quiet` flag**: print only the summary line. Touches `src/cli.ts` and `src/report/terminal.ts`.
2. **Parse `.env` files with inline `export` and tabs in more edge cases**: add tests for values like `KEY=a=b`, empty quotes, trailing spaces after quotes.
3. **Show scanned file line numbers in the JSON report**: `EnvEntry.line` is already tracked; surface it in `SecretResult`.
4. **`--env-file` should warn when a named file does not exist**, without printing its contents.
5. **Markdown report renderer** (`src/report/markdown.ts`) for pasting into PRs.
6. **Windows path handling** in `--dir` and the CLI entrypoint check; add a Windows job to CI.
