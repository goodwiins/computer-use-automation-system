import { defineConfig } from 'vitest/config';

// Only the repo's own suites. Nested git worktrees (e.g. .claude/worktrees/)
// carry a second copy of every test file, and their e2e suites race this
// one for the same fixed port.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '.claude/**'] },
});
