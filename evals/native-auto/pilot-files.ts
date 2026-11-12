// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export async function captureChanges(workspace: string, base: string, env: NodeJS.ProcessEnv) {
  const options = { cwd: workspace, env, maxBuffer: 8 * 1024 * 1024 };
  await execFile("git", ["add", "--intent-to-add", "--all"], options);
  const [diff, names] = await Promise.all([
    execFile("git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", base, "--"], options),
    execFile("git", ["diff", "--name-only", base, "--"], options),
  ]);
  return { diff: diff.stdout, files: names.stdout.trim().split("\n").filter(Boolean) };
}
