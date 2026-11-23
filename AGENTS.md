# AGENTS.md

<!-- skillhawk:setup start -->
## How to write code here (skillhawk setup)

- Language: JavaScript.
- Formatter/linter: None, match the existing code. Run it before you finish.
- Style: 2 spaces indentation, single quotes, semicolons always, ES modules (import/export).
- Naming: functions camelCase, files kebab-case.
- Tests: npm test (runs: node --test test/*.test.js); add or update a test with every behaviour change.
- Architecture: Keep the current layout; put new code next to similar code.
- Commits: Match the existing style: e.g. "README: runs-locally note, install page, listings, contact".
- Comments: Comment why, not what; keep comments short.

Known problems (from `skillhawk health`); do not make these worse, and fix them when you touch that code:
- Very large file: web/app.js: 1305 lines
- Import cycle: src/review.js -> src/clean.js -> src/review.js
- Import cycle: src/eval.js -> src/studio/llm.js -> src/eval.js
- Import cycle: src/store.js -> src/vault.js -> src/store.js
- Long function: src/prerender.js:64 prerenderSite(): 415 lines
<!-- skillhawk:setup end -->
