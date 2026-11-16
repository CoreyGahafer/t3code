// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EvaluationError } from "./evaluate.ts";
import { captureChanges } from "./pilot-files.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const env = { PATH: process.env.PATH };

it.live("preserves unstaged, staged, new and committed source against the pinned base", () =>
  Effect.tryPromise({
    try: async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-pilot-diff-"));
      const git = (...args: string[]) =>
        execFile(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            ...args,
          ],
          { cwd: directory, env },
        );
      try {
        await git("init");
        await NodeFSP.writeFile(NodePath.join(directory, "unstaged.ts"), "original\n");
        await NodeFSP.writeFile(NodePath.join(directory, "staged.ts"), "original\n");
        await git("add", ".");
        await git("commit", "-m", "fixture base");
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        await NodeFSP.writeFile(NodePath.join(directory, "unstaged.ts"), "unstaged change\n");
        await NodeFSP.writeFile(NodePath.join(directory, "staged.ts"), "staged change\n");
        await git("add", "staged.ts");
        await NodeFSP.writeFile(NodePath.join(directory, "new.ts"), "new regression\n");
        for (const committed of [false, true]) {
          if (committed) {
            await git("add", ".");
            await git("commit", "-m", "candidate commit");
          }
          const changes = await captureChanges(directory, base, env);
          assert.deepEqual(changes.files, ["new.ts", "staged.ts", "unstaged.ts"]);
          for (const text of ["new regression", "staged change", "unstaged change"])
            assert.include(changes.diff, text);
        }
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
    catch: (cause) => new EvaluationError({ stage: "capture-regression", cause }),
  }),
);
