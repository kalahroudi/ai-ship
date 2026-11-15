import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_PROTECTED_PATHS,
  excludeFileDigest,
  snapshotIgnoredProtectedFiles,
  extractJsonKeys,
  extractTomlSections,
  isTesterPath,
  resolveRunStartRef,
  ProtectedPathError,
  assertProtectedPathsUnchanged,
  createCheckpoint,
  enforceTesterScope,
  findProtectedPathViolations,
  globToRegExp,
  headRef,
  restoreTamperedFiles,
  snapshotFiles,
  squashCheckpoints,
} from "../src/integrity.ts";
import { commitAll, createWorktree, openPrFromWorktree } from "../src/git.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { OpencodeClient } from "../src/runner.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function write(dir: string, file: string, content: string): void {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-ship-integrity-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function withRepo(files: Record<string, string>, fn: (dir: string, ref: string) => void): void {
  const dir = makeRepo(files);
  try {
    fn(dir, headRef(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PKG = (scripts: Record<string, string>, deps: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", scripts, dependencies: deps }, null, 2) + "\n";

test("globToRegExp handles **, * and ?", () => {
  assert.ok(globToRegExp("**/package.json").test("package.json"));
  assert.ok(globToRegExp("**/package.json").test("a/b/package.json"));
  assert.ok(globToRegExp(".github/workflows/**").test(".github/workflows/ci.yml"));
  assert.ok(globToRegExp("**/tsconfig*.json").test("tsconfig.base.json"));
  assert.ok(!globToRegExp("*.json").test("a/b.json"));
  assert.ok(globToRegExp("a?.json").test("ab.json"));
  assert.ok(!globToRegExp("a?.json").test("a/.json"));
});

test("findProtectedPathViolations flags gate files but not ordinary edits", () => {
  withRepo(
    { "package.json": PKG({ test: "node --test" }), "src/a.ts": "export const a = 1;\n", ".ai-ship.json": "{}\n" },
    (dir, ref) => {
      assert.deepEqual(findProtectedPathViolations(dir, ref, DEFAULT_PROTECTED_PATHS), []);

      write(dir, "src/a.ts", "export const a = 2;\n");
      assert.deepEqual(findProtectedPathViolations(dir, ref, DEFAULT_PROTECTED_PATHS), []);

      // dependency-only change is fine
      write(dir, "package.json", PKG({ test: "node --test" }, { left: "1.0.0" }));
      assert.deepEqual(findProtectedPathViolations(dir, ref, DEFAULT_PROTECTED_PATHS), []);

      // scripts change is a violation
      write(dir, "package.json", PKG({ test: "exit 0" }, { left: "1.0.0" }));
      const v1 = findProtectedPathViolations(dir, ref, DEFAULT_PROTECTED_PATHS);
      assert.equal(v1.length, 1);
      assert.match(v1[0], /package\.json/);
      write(dir, "package.json", PKG({ test: "node --test" }));

      write(dir, ".github/workflows/x.yml", "on: push\n");
      assert.ok(findProtectedPathViolations(dir, ref).some((v) => v.includes(".github/workflows/x.yml")));
      fs.rmSync(path.join(dir, ".github"), { recursive: true });

      write(dir, ".ai-ship.json", '{"safetyCheck": false}\n');
      assert.ok(findProtectedPathViolations(dir, ref).some((v) => v.includes(".ai-ship.json")));
    }
  );
});

test("assertProtectedPathsUnchanged throws ProtectedPathError, or logs when allowed", () => {
  withRepo({ "package.json": PKG({ test: "node --test" }) }, (dir, ref) => {
    write(dir, "package.json", PKG({ test: "exit 0" }));
    assert.throws(
      () => assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "Stage 1" }),
      (err: unknown) => err instanceof ProtectedPathError && err.violations.length === 1
    );
    const logs: string[] = [];
    assert.doesNotThrow(() =>
      assertProtectedPathsUnchanged({
        worktreeDir: dir,
        sinceRef: ref,
        stage: "Stage 1",
        allow: true,
        log: (l) => logs.push(l),
      })
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], /package\.json/);
  });
});

test("enforceTesterScope keeps new tests and reverts production edits, new files and test deletions", () => {
  withRepo(
    { "src/a.ts": "export const a = 1;\n", "tests/old.test.ts": "// old\n" },
    (dir, ref) => {
      write(dir, "tests/new.test.ts", "// new\n");
      write(dir, "src/a.ts", "export const a = 99;\n");
      write(dir, "src/new.ts", "export const n = 1;\n");
      fs.rmSync(path.join(dir, "tests/old.test.ts"));

      const res = enforceTesterScope(dir, ref);
      assert.ok(res.testerFiles.includes("tests/new.test.ts"));
      assert.ok(!res.testerFiles.includes("tests/old.test.ts"));
      assert.ok(res.reverted.includes("src/a.ts"));
      assert.ok(res.reverted.includes("src/new.ts"));
      assert.ok(res.reverted.includes("tests/old.test.ts"));

      assert.equal(fs.readFileSync(path.join(dir, "tests/new.test.ts"), "utf8"), "// new\n");
      assert.equal(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8"), "export const a = 1;\n");
      assert.ok(!fs.existsSync(path.join(dir, "src/new.ts")));
      assert.equal(fs.readFileSync(path.join(dir, "tests/old.test.ts"), "utf8"), "// old\n");
    }
  );
});

test("snapshotFiles/restoreTamperedFiles restore modified and deleted files only", () => {
  withRepo({ "tests/a.test.ts": "// a\n", "tests/b.test.ts": "// b\n", "tests/c.test.ts": "// c\n" }, (dir) => {
    const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
    const snap = snapshotFiles(dir, files);
    const ref = createCheckpoint(dir, "cp"); // nothing to commit: returns HEAD
    write(dir, "tests/a.test.ts", "// tampered\n");
    fs.rmSync(path.join(dir, "tests/b.test.ts"));

    const restored = restoreTamperedFiles(dir, snap, ref);
    assert.deepEqual(restored.sort(), ["tests/a.test.ts", "tests/b.test.ts"]);
    assert.equal(fs.readFileSync(path.join(dir, "tests/a.test.ts"), "utf8"), "// a\n");
    assert.equal(fs.readFileSync(path.join(dir, "tests/b.test.ts"), "utf8"), "// b\n");
    assert.deepEqual(restoreTamperedFiles(dir, snap, ref), []);
  });
});

test("squashCheckpoints soft-resets checkpoint commits, leaving changes staged", () => {
  withRepo({ "src/a.ts": "1\n" }, (dir, start) => {
    write(dir, "src/a.ts", "2\n");
    createCheckpoint(dir, "cp1");
    write(dir, "src/b.ts", "b\n");
    createCheckpoint(dir, "cp2");
    assert.equal(git(dir, "rev-list", "--count", `${start}..HEAD`).trim(), "2");

    squashCheckpoints(dir, start);
    assert.equal(headRef(dir), start);
    const staged = git(dir, "diff", "--cached", "--name-only").trim().split("\n").sort();
    assert.deepEqual(staged, ["src/a.ts", "src/b.ts"]);
  });
});

test("openPrFromWorktree scans using main-repo config, not the worktree's .ai-ship.json (gate bypass)", () => {
  const repoDir = makeRepo({ "README.md": "# t\n", ".gitignore": ".ai-ship-worktrees/\n" });
  try {
    const wt = createWorktree(repoDir, "main", "weaken gate");
    write(wt.worktreeDir, ".ai-ship.json", JSON.stringify({ safetyCheck: false, safetyAllowlist: ["/.*/"] }));
    const fakeKey = "AKIA" + "ABCDEFGHIJKLMNOP";
    write(wt.worktreeDir, "src/leak.ts", `export const key = "${fakeKey}";\n`);
    commitAll(wt.worktreeDir, "leak");

    let pushCalled = false;
    assert.throws(
      () =>
        openPrFromWorktree(
          { repoDir, worktreeDir: wt.worktreeDir, branch: wt.branch, baseBranch: "main", title: "Leak" },
          {
            rebase: () => ({ updated: false, conflicted: false, targetRef: "main", conflictedFiles: [] }),
            pushAndOpen: () => {
              pushCalled = true;
              return "https://github.com/o/r/pull/1";
            },
          }
        ),
      /Safety check FAILED/
    );
    assert.equal(pushCalled, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

function pipelineRepo(): string {
  return makeRepo({
    "README.md": "# t\n",
    "package.json": PKG({ test: "node --test" }),
    ".gitignore": ".ai-ship-worktrees/\n",
    ".ai-ship.json": JSON.stringify({
      baseBranch: "main",
      verify: [],
      maxFixRetries: 1,
      maxReviewRounds: 1,
      securityScan: false,
      safetyCheck: false,
    }),
  });
}

function fakeClientFor(repoDir: string, onPrompt: (worktreeDir: string, n: number) => void): OpencodeClient {
  let sess = 0;
  let n = 0;
  return {
    session: {
      async create() {
        return { data: { id: `s-${++sess}` } };
      },
      async prompt() {
        const root = path.join(repoDir, ".ai-ship-worktrees");
        const wt = path.join(root, fs.readdirSync(root)[0]);
        onPrompt(wt, ++n);
        return {
          data: {
            parts: [{ type: "text", text: "Done.\nVERDICT: CLEAN" }],
            info: { cost: 0.01, tokens: { input: 10, output: 5 } },
          },
        };
      },
    },
  } as unknown as OpencodeClient;
}

test("runPipeline rejects with ProtectedPathError when the implementer rewrites package.json scripts", async () => {
  const repoDir = pipelineRepo();
  try {
    const client = fakeClientFor(repoDir, (wt) => write(wt, "package.json", PKG({ test: "exit 0" })));
    await assert.rejects(
      () => runPipeline({ repoDir, task: "weaken", openPr: false, skipTests: true, skipReview: true, client }),
      (err: unknown) => err instanceof ProtectedPathError
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runPipeline ends with exactly one commit beyond base", async () => {
  const repoDir = pipelineRepo();
  try {
    const base = headRef(repoDir);
    const client = fakeClientFor(repoDir, (wt, n) => {
      if (n === 1) write(wt, "src/feature.ts", "export const f = 1;\n");
    });
    const result = await runPipeline({
      repoDir,
      task: "add feature",
      openPr: false,
      skipTests: true,
      skipReview: true,
      client,
    });
    assert.equal(result.committed, true);
    assert.equal(git(repoDir, "rev-list", "--count", `${base}..${result.branch}`).trim(), "1");
    assert.match(git(repoDir, "show", "--name-only", "--pretty=", result.branch), /src\/feature\.ts/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("package-manager config files are protected", () => {
  withRepo({ "README.md": "x\n" }, (dir, ref) => {
    for (const f of [".npmrc", ".yarnrc.yml", "pnpm-workspace.yaml"]) {
      write(dir, f, "script-shell=/usr/bin/true\n");
      assert.ok(findProtectedPathViolations(dir, ref).some((v) => v.startsWith(f)), f);
      fs.rmSync(path.join(dir, f));
    }
  });
});

test("hiding a new gate file via .gitignore or .git/info/exclude is caught", () => {
  withRepo({ ".gitignore": "node_modules\n" }, (dir, ref) => {
    write(dir, "vitest.config.ts", "export default {};\n");
    write(dir, ".gitignore", "node_modules\nvitest.config.ts\n");
    const v = findProtectedPathViolations(dir, ref);
    assert.ok(v.some((x) => x.startsWith(".gitignore")));

    fs.rmSync(path.join(dir, "vitest.config.ts"));
    write(dir, ".gitignore", "node_modules\n");
    assert.deepEqual(findProtectedPathViolations(dir, ref), []);

    const digest = excludeFileDigest(dir);
    assert.doesNotThrow(() =>
      assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", excludeDigest: digest })
    );
    fs.appendFileSync(path.join(dir, ".git/info/exclude"), "vitest.config.ts\n");
    assert.throws(
      () => assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", excludeDigest: digest }),
      ProtectedPathError
    );
  });
});

test("package.json gate keys and pyproject sections are compared, other changes are not", () => {
  const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: "x", ...o }, null, 2) + "\n";
  withRepo(
    {
      "package.json": pkg({ jest: { bail: 1 }, dependencies: { a: "1" } }),
      "pyproject.toml": "[project]\ndependencies = [\"a\"]\n\n[tool.pytest.ini_options]\naddopts = \"-x\"\n",
    },
    (dir, ref) => {
      write(dir, "package.json", pkg({ jest: { bail: 1 }, dependencies: { a: "1", b: "2" } }));
      write(dir, "pyproject.toml", "[project]\ndependencies = [\"a\", \"b\"]\n\n[tool.pytest.ini_options]\naddopts = \"-x\"\n");
      assert.deepEqual(findProtectedPathViolations(dir, ref), []);

      write(dir, "package.json", pkg({ jest: { testMatch: [] }, dependencies: { a: "1" } }));
      assert.ok(findProtectedPathViolations(dir, ref).some((v) => v.startsWith("package.json")));
      write(dir, "package.json", pkg({ jest: { bail: 1 }, dependencies: { a: "1" } }));

      write(dir, "pyproject.toml", "[project]\ndependencies = [\"a\"]\n\n[tool.pytest.ini_options]\naddopts = \"\"\n");
      assert.ok(findProtectedPathViolations(dir, ref).some((v) => v.startsWith("pyproject.toml")));
    }
  );
});

test("extractJsonKeys and extractTomlSections pick only gate parts", () => {
  const a = extractJsonKeys('{"scripts":{"t":"1"},"dependencies":{"x":"1"}}', ["scripts"]);
  const b = extractJsonKeys('{"scripts":{"t":"1"},"dependencies":{"y":"2"}}', ["scripts"]);
  const c = extractJsonKeys('{"scripts":{"t":"2"}}', ["scripts"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(extractJsonKeys(undefined, ["scripts"]), "null");

  const toml = '[project]\nname="x"\n\n[tool.pytest.ini_options]\naddopts="-x"\n\n[tool.black]\nline=1\n';
  const out = extractTomlSections(toml, ["tool.pytest"]);
  assert.match(out, /addopts/);
  assert.doesNotMatch(out, /black|name=/);
  assert.equal(extractTomlSections(undefined, ["tool.pytest"]), "null");
});

test("isTesterPath and enforceTesterScope handle Go/Python tests and protect conftest/tsconfig in tests/", () => {
  for (const p of ["pkg/x_test.go", "test_x.py", "tests/fixtures/a.json", "e2e/login.spec.ts", "spec/models/user_spec.rb"]) {
    assert.ok(isTesterPath(p), p);
  }
  assert.ok(!isTesterPath("src/a.ts"));

  withRepo({ "src/a.ts": "1\n" }, (dir, ref) => {
    write(dir, "pkg/x_test.go", "package x\n");
    write(dir, "test_x.py", "pass\n");
    write(dir, "tests/conftest.py", "# evil\n");
    write(dir, "tests/tsconfig.json", "{}\n");
    const res = enforceTesterScope(dir, ref);
    assert.ok(res.testerFiles.includes("pkg/x_test.go"));
    assert.ok(res.testerFiles.includes("test_x.py"));
    assert.ok(res.reverted.includes("tests/conftest.py"));
    assert.ok(res.reverted.includes("tests/tsconfig.json"));
    assert.ok(!fs.existsSync(path.join(dir, "tests/conftest.py")));
    assert.ok(!fs.existsSync(path.join(dir, "tests/tsconfig.json")));
  });
});

test("resolveRunStartRef skips trailing checkpoint commits only", () => {
  withRepo({ "a.txt": "0\n" }, (dir, base) => {
    write(dir, "a.txt", "1\n");
    git(dir, "commit", "-q", "-am", "real work");
    const real = headRef(dir);
    assert.equal(resolveRunStartRef(dir), real);
    write(dir, "a.txt", "2\n");
    createCheckpoint(dir, "ai-ship: checkpoint stage 1");
    write(dir, "a.txt", "3\n");
    createCheckpoint(dir, "ai-ship: checkpoint stage 2");
    assert.equal(resolveRunStartRef(dir), real);
    assert.notEqual(real, base);
  });
});

test("commitAll throws when a pre-commit hook fails", () => {
  const repoDir = makeRepo({ "README.md": "# t\n", ".gitignore": ".ai-ship-worktrees/\n" });
  try {
    const wt = createWorktree(repoDir, "main", "hook");
    const hook = path.join(repoDir, ".git/hooks/pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho nope >&2\nexit 1\n", { mode: 0o755 });
    write(wt.worktreeDir, "src/a.ts", "x\n");
    assert.throws(() => commitAll(wt.worktreeDir, "msg"), /git commit failed/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runPipeline with allowConfigChange tolerates a scripts edit", async () => {
  const repoDir = pipelineRepo();
  try {
    const client = fakeClientFor(repoDir, (wt) => write(wt, "package.json", PKG({ test: "exit 0" })));
    const result = await runPipeline({
      repoDir,
      task: "intended config change",
      openPr: false,
      skipTests: true,
      skipReview: true,
      allowConfigChange: true,
      client,
    });
    assert.equal(result.committed, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runPipeline restores tester-owned tests edited by an implementer fix turn", async () => {
  const repoDir = makeRepo({
    "README.md": "# t\n",
    ".gitignore": ".ai-ship-worktrees/\n",
    ".ai-ship.json": JSON.stringify({
      baseBranch: "main",
      verify: ['node -e "process.exit(require(\'fs\').existsSync(\'flag.txt\')?0:1)"'],
      maxFixRetries: 2,
      maxReviewRounds: 1,
      securityScan: false,
      safetyCheck: false,
    }),
  });
  try {
    const testerVersion = "// tester version\n";
    const client = fakeClientFor(repoDir, (wt, n) => {
      if (n === 1) write(wt, "src/feature.ts", "export const f = 1;\n");
      else if (n === 2) write(wt, "tests/t.test.ts", testerVersion);
      else if (n === 3) {
        write(wt, "tests/t.test.ts", "// weakened\n");
        write(wt, "flag.txt", "ok\n");
      }
    });
    const result = await runPipeline({
      repoDir,
      task: "feature",
      openPr: false,
      skipReview: true,
      client,
    });
    assert.equal(fs.readFileSync(path.join(result.worktreeDir, "tests/t.test.ts"), "utf8"), testerVersion);
    assert.equal(git(repoDir, "show", `${result.branch}:tests/t.test.ts`), testerVersion);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ignored protected files are tracked via baseline; node_modules is skipped", () => {
  withRepo({ ".gitignore": ".npmrc\nnode_modules\n", "README.md": "x\n" }, (dir, ref) => {
    const run = (baseline: ReturnType<typeof snapshotIgnoredProtectedFiles>) => {
      try {
        assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", ignoredBaseline: baseline });
        return [];
      } catch (e) {
        assert.ok(e instanceof ProtectedPathError);
        return e.violations;
      }
    };
    const base0 = snapshotIgnoredProtectedFiles(dir);
    write(dir, "node_modules/x/tsconfig.json", "{}\n");
    assert.deepEqual(run(base0), []);

    write(dir, ".npmrc", "script-shell=/usr/bin/true\n");
    assert.ok(run(base0).some((v) => v === ".npmrc (ignored file added)"));

    const base1 = snapshotIgnoredProtectedFiles(dir);
    assert.deepEqual(run(base1), []);
    write(dir, ".npmrc", "script-shell=/bin/sh\n");
    assert.ok(run(base1).some((v) => v === ".npmrc (ignored file changed)"));
    fs.rmSync(path.join(dir, ".npmrc"));
    assert.ok(run(base1).some((v) => v === ".npmrc (ignored file deleted)"));
  });
});

test("skip-worktree flag and core.excludesFile changes after the digest are caught", () => {
  withRepo({ "package.json": PKG({ test: "node --test" }) }, (dir, ref) => {
    const digest = excludeFileDigest(dir);
    git(dir, "update-index", "--skip-worktree", "package.json");
    write(dir, "package.json", PKG({ test: "exit 0" }));
    assert.throws(
      () => assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", excludeDigest: digest }),
      ProtectedPathError
    );
    git(dir, "update-index", "--no-skip-worktree", "package.json");
    write(dir, "package.json", PKG({ test: "node --test" }));
    assert.doesNotThrow(() =>
      assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", excludeDigest: digest })
    );

    const ex = path.join(dir, "..", path.basename(dir) + "-excludes");
    fs.writeFileSync(ex, "vitest.config.ts\n");
    try {
      git(dir, "config", "core.excludesFile", ex);
      assert.throws(
        () => assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", excludeDigest: digest }),
        ProtectedPathError
      );
    } finally {
      fs.rmSync(ex, { force: true });
    }
  });
});

test("ignored build output directories do not trigger violations, individually ignored .npmrc still does", () => {
  withRepo({ ".gitignore": "dist/\n.next/\n.venv/\nlocal.config.json\n.npmrc\n", "README.md": "x\n" }, (dir, ref) => {
    const baseline = snapshotIgnoredProtectedFiles(dir);
    write(dir, "dist/package.json", PKG({ build: "tsc" }));
    write(dir, ".next/package.json", '{"type":"commonjs"}\n');
    write(dir, ".venv/lib/conftest.py", "# generated\n");
    write(dir, "local.config.json", "{}\n");
    assert.doesNotThrow(() =>
      assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", ignoredBaseline: baseline })
    );

    write(dir, ".npmrc", "script-shell=/usr/bin/true\n");
    assert.throws(
      () => assertProtectedPathsUnchanged({ worktreeDir: dir, sinceRef: ref, stage: "s", ignoredBaseline: baseline }),
      (e: unknown) => e instanceof ProtectedPathError && e.violations.some((v) => v === ".npmrc (ignored file added)")
    );
  });
});
