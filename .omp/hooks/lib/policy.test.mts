import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeRepoPath,
  classifyGitCommitCommands,
  hasGatedPath,
  isProtectedBranch,
  isProtectedEditPath,
  resolveGitCommitCwd,
} from "./policy.mts";

const repoRoot = "/workspace/nevix-ai";

test("canonicalizeRepoPath normalizes repository-relative and absolute paths", () => {
  const cases = [
    {
      name: "relative",
      input: "./apps/desktop/main.ts",
      want: "apps/desktop/main.ts",
    },
    {
      name: "absolute",
      input: "/workspace/nevix-ai/server/cmd/server/main.go",
      want: "server/cmd/server/main.go",
    },
    {
      name: "parent segments inside repository",
      input: "docs/../contracts/api.ts",
      want: "contracts/api.ts",
    },
    { name: "repository root", input: "/workspace/nevix-ai", want: "" },
    {
      name: "outside repository",
      input: "/workspace/other/file.ts",
      want: null,
    },
  ];

  for (const { name, input, want } of cases) {
    assert.equal(canonicalizeRepoPath(input, repoRoot), want, name);
  }
});

test("isProtectedEditPath handles absolute and relative lockfile and env paths", () => {
  const cases = [
    { name: "relative lockfile", path: "pnpm-lock.yaml", want: true },
    {
      name: "absolute nested env",
      path: "/workspace/nevix-ai/apps/desktop/.env.local",
      want: true,
    },
    { name: "ordinary file", path: "apps/desktop/src/main.ts", want: false },
    {
      name: "outside repository env",
      path: "/workspace/other/.env",
      want: false,
    },
  ];

  for (const { name, path, want } of cases) {
    assert.equal(isProtectedEditPath(path, repoRoot), want, name);
  }
});

test("hasGatedPath checks every canonicalized changed path", () => {
  const cases = [
    { name: "gated first", paths: "apps/a.ts\ndocs/x.md", want: true },
    {
      name: "gated last closes multiline bypass",
      paths: "docs/x.md\napps/a.ts",
      want: true,
    },
    {
      name: "server last closes multiline bypass",
      paths: "README.md\nserver/main.go",
      want: true,
    },
    { name: "ungated files", paths: "README.md\ndocs/x.md", want: false },
    {
      name: "absolute and relative paths",
      paths: "/workspace/nevix-ai/docs/x.md\n./contracts/api.ts",
      want: true,
    },
    {
      name: "rename from gated path",
      paths: "apps/desktop/old.ts\ndocs/new.ts",
      want: true,
    },
    {
      name: "rename to gated path in reverse order",
      paths: "apps/desktop/new.ts\ndocs/old.ts",
      want: true,
    },
    {
      name: "rename within docs",
      paths: "docs/old.md\ndocs/new.md",
      want: false,
    },
  ];

  for (const { name, paths, want } of cases) {
    assert.equal(hasGatedPath(paths, repoRoot), want, name);
  }
});

test("isProtectedBranch only protects main", () => {
  const cases = [
    { branch: "main", want: true },
    { branch: "feature/repo-policy", want: false },
    { branch: "", want: false },
  ];

  for (const { branch, want } of cases) {
    assert.equal(isProtectedBranch(branch), want, branch || "detached HEAD");
  }
});

test("classifyGitCommitCommands handles cwd, --all, and pathspec forms", () => {
  const commit = (
    cwdChanges: string[] = [],
    stagesAll = false,
    includesPathspec = false,
  ) => ({ cwdChanges, stagesAll, includesPathspec });
  const cases = [
    {
      name: "plain commit",
      command: 'git commit -m "docs"',
      want: [commit()],
      wantCwd: repoRoot,
    },
    {
      name: "git -C relative path",
      command: 'git -C ../nevix-ai commit -m "change"',
      want: [commit(["../nevix-ai"])],
      wantCwd: repoRoot,
    },
    {
      name: "git -C quoted absolute path and --all",
      command: 'git -C "/workspace/nevix ai" commit --all -m "change"',
      want: [commit(["/workspace/nevix ai"], true)],
      wantCwd: "/workspace/nevix ai",
    },
    {
      name: "multiple git -C options apply in order",
      command: 'git -C .. -C nevix-ai commit -m "change"',
      want: [commit(["..", "nevix-ai"])],
      wantCwd: repoRoot,
    },
    {
      name: "cd and git -C apply in order",
      command: 'cd /workspace && git -C nevix-ai commit -m "change"',
      want: [commit(["/workspace", "nevix-ai"])],
      wantCwd: repoRoot,
    },
    {
      name: "short all flag",
      command: 'git commit -am "change"',
      want: [commit([], true)],
      wantCwd: repoRoot,
    },
    {
      name: "message value is not short all flag or pathspec",
      command: "git commit -ma",
      want: [commit()],
      wantCwd: repoRoot,
    },
    {
      name: "direct pathspec includes worktree changes",
      command: 'git commit -m "change" apps/desktop/main.ts',
      want: [commit([], false, true)],
      wantCwd: repoRoot,
    },
    {
      name: "pathspec after separator",
      command: "git commit -- apps/desktop/main.ts",
      want: [commit([], false, true)],
      wantCwd: repoRoot,
    },
    {
      name: "amend is not all or pathspec",
      command: "git commit --amend --no-edit",
      want: [commit()],
      wantCwd: repoRoot,
    },
    {
      name: "quoted text is not a command",
      command: "echo 'git commit --all'",
      want: [],
      wantCwd: null,
    },
    {
      name: "other git command",
      command: "git status",
      want: [],
      wantCwd: null,
    },
  ];

  for (const { name, command, want, wantCwd } of cases) {
    const result = classifyGitCommitCommands(command);
    assert.deepEqual(result, want, name);
    assert.equal(
      result[0] ? resolveGitCommitCwd(repoRoot, result[0]) : null,
      wantCwd,
      name,
    );
  }
});
