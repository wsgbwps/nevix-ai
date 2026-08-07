import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export interface GitCommitCommand {
  cwdChanges: string[];
  stagesAll: boolean;
  includesPathspec: boolean;
}

const GATED_DIRECTORIES = [
  "apps",
  "server",
  "supabase",
  "contracts",
  "scripts",
  ".github",
];
const GATED_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "go.work",
  "go.work.sum",
]);

/** Return a slash-separated repository path, or null when the input is outside the repository. */
export function canonicalizeRepoPath(
  inputPath: string,
  repoRoot: string,
): string | null {
  const value = inputPath.trim();
  if (!value) return null;

  const root = resolve(repoRoot);
  const repoRelative = relative(root, resolve(root, value));
  if (
    repoRelative === ".." ||
    repoRelative.startsWith(`..${sep}`) ||
    isAbsolute(repoRelative)
  ) {
    return null;
  }
  return repoRelative.split(sep).join("/");
}

export function isProtectedEditPath(
  inputPath: string,
  repoRoot: string,
): boolean {
  const repoPath = canonicalizeRepoPath(inputPath, repoRoot);
  if (repoPath === null) return false;

  const filename = basename(repoPath);
  return (
    filename === "pnpm-lock.yaml" ||
    filename === ".env" ||
    filename.startsWith(".env.")
  );
}

export function isGatedRepoPath(repoPath: string): boolean {
  return (
    GATED_ROOT_FILES.has(repoPath) ||
    GATED_DIRECTORIES.some((directory) => repoPath.startsWith(`${directory}/`))
  );
}

/** Git output is intentionally checked one path per line so file order cannot bypass the gate. */
export function hasGatedPath(changedPaths: string, repoRoot: string): boolean {
  return changedPaths.split(/\r?\n/).some((inputPath) => {
    const repoPath = canonicalizeRepoPath(inputPath, repoRoot);
    return repoPath !== null && isGatedRepoPath(repoPath);
  });
}

export function isProtectedBranch(branch: string): boolean {
  return branch === "main";
}

interface ShellToken {
  value: string;
  operator: boolean;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  const pushCurrent = (): void => {
    if (!tokenStarted) return;
    tokens.push({ value: current, operator: false });
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < command.length
      ) {
        index += 1;
        current += command[index];
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\" && index + 1 < command.length) {
      tokenStarted = true;
      index += 1;
      current += command[index];
    } else if (/\s/.test(character)) {
      pushCurrent();
      if (character === "\n") tokens.push({ value: character, operator: true });
    } else if (";&|()".includes(character)) {
      pushCurrent();
      const doubled =
        index + 1 < command.length && command[index + 1] === character;
      tokens.push({
        value: doubled ? character + character : character,
        operator: true,
      });
      if (doubled) index += 1;
    } else {
      tokenStarted = true;
      current += character;
    }
  }
  pushCurrent();
  return tokens;
}

function stagesAll(commitArguments: string[]): boolean {
  for (const argument of commitArguments) {
    if (argument === "--") return false;
    if (argument === "--all") return true;
    if (!/^-[^-]/.test(argument)) continue;

    const shortOptions = argument.slice(1);
    const valueOptionIndex = shortOptions.search(/[mcCFS]/);
    const optionFlags =
      valueOptionIndex === -1
        ? shortOptions
        : shortOptions.slice(0, valueOptionIndex);
    if (optionFlags.includes("a")) return true;
  }
  return false;
}

const COMMIT_LONG_OPTIONS_WITH_VALUES = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--fixup",
  "--message",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
  "--trailer",
]);

function includesPathspec(commitArguments: string[]): boolean {
  let consumesNext = false;
  for (let index = 0; index < commitArguments.length; index += 1) {
    const argument = commitArguments[index];
    if (consumesNext) {
      consumesNext = false;
      continue;
    }
    if (argument === "--") return index + 1 < commitArguments.length;
    if (
      argument === "--pathspec-from-file" ||
      argument.startsWith("--pathspec-from-file=")
    ) {
      return true;
    }
    if (argument.startsWith("--")) {
      const [option, inlineValue] = argument.split("=", 2);
      consumesNext =
        inlineValue === undefined &&
        COMMIT_LONG_OPTIONS_WITH_VALUES.has(option);
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      const shortOptions = argument.slice(1);
      const valueOptionIndex = shortOptions.search(/[mFcCt]/);
      consumesNext = valueOptionIndex === shortOptions.length - 1;
      continue;
    }
    return true;
  }
  return false;
}

function cdTarget(segment: string[]): string | null {
  if (
    segment.length === 2 &&
    segment[0] === "cd" &&
    !segment[1].startsWith("-")
  ) {
    return segment[1];
  }
  if (segment.length === 3 && segment[0] === "cd" && segment[1] === "--") {
    return segment[2];
  }
  return null;
}

function classifyGitSegment(
  segment: string[],
  shellCwdChanges: string[],
): GitCommitCommand | null {
  if (segment.length === 0 || basename(segment[0]) !== "git") return null;

  const cwdChanges = [...shellCwdChanges];
  let index = 1;
  while (index < segment.length) {
    const argument = segment[index];
    if (argument === "-C") {
      if (index + 1 >= segment.length) return null;
      cwdChanges.push(segment[index + 1]);
      index += 2;
    } else if (argument.startsWith("-C") && argument.length > 2) {
      cwdChanges.push(argument.slice(2));
      index += 1;
    } else if (argument === "-c" || argument === "--config-env") {
      index += 2;
    } else if (argument.startsWith("-")) {
      index += 1;
    } else {
      break;
    }
  }

  if (segment[index] !== "commit") return null;
  const commitArguments = segment.slice(index + 1);
  return {
    cwdChanges,
    stagesAll: stagesAll(commitArguments),
    includesPathspec: includesPathspec(commitArguments),
  };
}

export function classifyGitCommitCommands(command: string): GitCommitCommand[] {
  const commits: GitCommitCommand[] = [];
  const shellCwdChanges: string[] = [];
  let segment: string[] = [];

  const completeSegment = (operator: string | null): void => {
    const commit = classifyGitSegment(segment, shellCwdChanges);
    if (commit !== null) commits.push(commit);

    const target = cdTarget(segment);
    if (
      target !== null &&
      (operator === "&&" || operator === ";" || operator === "\n")
    ) {
      shellCwdChanges.push(target);
    }
    segment = [];
  };

  for (const token of tokenizeShell(command)) {
    if (token.operator) completeSegment(token.value);
    else segment.push(token.value);
  }
  completeSegment(null);
  return commits;
}

export function resolveGitCommitCwd(
  baseCwd: string,
  commit: GitCommitCommand,
): string {
  return commit.cwdChanges.reduce(
    (cwd, change) => resolve(cwd, change),
    resolve(baseCwd),
  );
}
