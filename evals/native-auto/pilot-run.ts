#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ByteSize from "effect/ByteSize";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import createBudgetTable from "../../apps/server/src/persistence/Migrations/082_NativeAutoEvaluationBudget.ts";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import { EvaluationError, Pricing, tokenCost } from "./evaluate.ts";
import { guard, initializeGuard } from "./guard.ts";
import { runPilot, type PilotResult, type PilotTask } from "./pilot.ts";
import { captureChanges } from "./pilot-files.ts";
import { requestPaid } from "./transport.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeUsageEnvelope = Schema.decodeUnknownEffect(Schema.Struct({ usage: Schema.Unknown }));
const repository = NodePath.resolve(import.meta.dirname, "../..");
const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    manifest: { type: "string" },
    fixtures: { type: "string" },
    binary: { type: "string" },
    sha256: { type: "string" },
    pricing: { type: "string" },
    samples: { type: "string", default: "1" },
    paid: { type: "boolean", default: false },
    "approve-astra": { type: "boolean", default: false },
    "offline-endpoint": { type: "string" },
    "review-gate": { type: "string" },
  },
});
if (!values.out || !values.manifest || !values.fixtures || !values.binary || !values.sha256)
  throw new Error(
    "Required: --out <new dir> --manifest <prepared manifest> --fixtures <operator dir> --binary <local Codex> --sha256 <pinned binary hash>.",
  );
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error("Use 1–10 samples.");
const paid = values.paid;
if (
  paid &&
  (!values["approve-astra"] ||
    !values.pricing ||
    !process.env.OPENAI_API_KEY ||
    process.env.OPENAI_BASE_URL ||
    values["offline-endpoint"])
)
  throw new Error(
    "Paid mode requires separate Astra approval, verified pricing, an API key and the direct OpenAI endpoint.",
  );
const origin = paid ? "https://api.openai.com" : new URL(values["offline-endpoint"] ?? "").origin;
if (!paid && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin))
  throw new Error("Offline fixtures require a loopback HTTP endpoint.");
const binary = await NodeFSP.realpath(values.binary);
const binaryHash = NodeCrypto.createHash("sha256")
  .update(await NodeFSP.readFile(binary))
  .digest("hex");
if (binaryHash !== values.sha256)
  throw new Error("Codex binary hash differs from the approved pin.");
const Manifest = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      base: Schema.String,
      prompt: Schema.String,
      rubric: Schema.String,
    }),
  ),
});
const { tasks } = Schema.decodeUnknownSync(Manifest)(
  JSON.parse(await NodeFSP.readFile(values.manifest, "utf8")),
);
if (
  tasks.map((task) => task.id).join() !==
    "01-mechanical,02-implementation,03-debugging,04-review,05-followup" ||
  tasks.some((task) => !/^[a-f0-9]{40}$/u.test(task.base))
)
  throw new Error("Use the pinned five-task manifest in its prepared order.");
const synthetic = {
  inputMicroUsdPerMillion: 1000000,
  outputMicroUsdPerMillion: 2000000,
  maximumInputTokens: 128000,
  maximumOutputTokens: 128000,
};
const pricing = Schema.decodeUnknownSync(Pricing)(
  paid
    ? JSON.parse(await NodeFSP.readFile(values.pricing!, "utf8"))
    : {
        revision: "synthetic-offline-not-billing",
        models: { "gpt-6-luna": synthetic, "gpt-6.1-sol": synthetic, "gpt-6-astra": synthetic },
      },
);
// Refuse before any classifier call when a full native request cannot fit the shared ceiling.
if (
  Object.values(pricing.models).some(
    (price) =>
      tokenCost(
        { input_tokens: price.maximumInputTokens, output_tokens: price.maximumOutputTokens },
        price,
      ) > 25_000_000,
  )
)
  throw new Error(
    "Verified full-request bounds exceed $25. No inference dispatched; do not lower bounds to force admission.",
  );
const out = NodePath.resolve(values.out);
await NodeFSP.mkdir(out, { mode: 0o700 });
const fixtures = await NodeFSP.realpath(values.fixtures);
const ledgerDirectory = NodePath.join(repository, "evals/runs");
await NodeFSP.mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
// The system temporary directory is writable by agent tools; keep live admission state elsewhere.
const guardRuntime = await NodeFSP.mkdtemp(NodePath.join(ledgerDirectory, "native-guard-"));
const ledger = paid
  ? NodePath.join(repository, "evals/runs/native-auto-budget.sqlite")
  : NodePath.join(guardRuntime, "budget.sqlite");
const database = NodeSqliteClient.layer({ filename: ledger });
const layer = Budget.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(createBudgetTable).pipe(Layer.provideMerge(database))),
);
const guardConfig = NodePath.join(guardRuntime, "guard.json");
await NodeFSP.writeFile(guardConfig, JSON.stringify({ database: ledger, origin, pricing }), {
  mode: 0o600,
});
const guardPath = NodePath.join(guardRuntime, "guard");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
await NodeFSP.writeFile(
  guardPath,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(NodePath.join(import.meta.dirname, "guard-cli.ts"))} ${quote(guardConfig)}\n`,
  { mode: 0o700 },
);
const key = paid ? process.env.OPENAI_API_KEY : undefined;
const env = Object.fromEntries(
  ["PATH", "TMPDIR", "LANG"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]!]] : [],
  ),
);
const command = async (file: string, args: string[], cwd: string, log: string) => {
  try {
    const result = await execFile(file, args, {
      cwd,
      env,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      signal: cancellation.signal,
    });
    await NodeFSP.writeFile(log, result.stdout + result.stderr);
    return { passed: true, feedback: result.stdout + result.stderr };
  } catch (cause) {
    const error = cause as NodeChildProcess.ExecFileException & {
      stdout?: string;
      stderr?: string;
    };
    const feedback = `${error.message}\n${error.stdout ?? ""}${error.stderr ?? ""}`;
    await NodeFSP.writeFile(log, feedback);
    return { passed: false, feedback: feedback.slice(-12000) };
  }
};
const attempt = <A>(stage: string, fn: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => new EvaluationError({ stage, cause }) });
const requestFixture = Effect.fn("NativeAutoPilot.fixtureRequest")(
  function* (body: unknown) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .pipe(HttpClient.filterStatusOk)
      .execute(
        HttpClientRequest.post(`${origin}/v1/decisions`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );
    return yield* response.json;
  },
  Effect.scoped,
  Effect.timeout("5 seconds"),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1)),
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError((cause) => new EvaluationError({ stage: "offline-classifier", cause })),
);
let workspace = "";
let home = "";
let session: string | undefined;
let currentDirectory = "";
let checkIndex = 0;
let beforeIds = new Set<string>();
const worktrees: string[] = [];
const homes: string[] = [];
const rows: (PilotResult & {
  sample: number;
  costMicroUsd: number;
  reservations: unknown;
  elapsedMs: number;
  diff: string;
})[] = [];
let started = 0;
let activeChild: NodeChildProcess.ChildProcess | undefined;
let activeClose: Promise<unknown> = Promise.resolve();
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const assertSettled = Effect.fn("NativeAutoPilot.assertSettled")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending =
    yield* sql`SELECT request_id FROM native_auto_evaluation_reservations WHERE actual_microusd IS NULL`;
  const state = yield* sql<{
    halted: number;
  }>`SELECT halted FROM native_auto_pilot_state WHERE id = 1`;
  if (pending.length > 0 || state[0]?.halted !== 0)
    return yield* new EvaluationError({ stage: "held-or-halted-ledger" });
});
const checks = async (task: PilotTask) => {
  checkIndex++;
  if (task.id === "04-review") {
    const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd: workspace, env });
    return { passed: stdout.trim() ? false : null, feedback: stdout };
  }
  if (task.id === "03-debugging")
    await NodeFSP.copyFile(
      NodePath.join(fixtures, "oracles/queue.integration.test.ts"),
      NodePath.join(
        workspace,
        "apps/server/src/orchestration-v2/NativeAutoRouting.integration.test.ts",
      ),
    );
  if (task.id === "05-followup")
    await NodeFSP.copyFile(
      NodePath.join(fixtures, "oracles/evaluate.test.ts"),
      NodePath.join(workspace, "evals/native-auto/evaluate.test.ts"),
    );
  const files =
    task.id === "01-mechanical"
      ? ["apps/server/src/orchestration-v2/NativeAutoRouting.test.ts"]
      : task.id === "03-debugging"
        ? [
            "apps/server/src/orchestration-v2/NativeAutoRouting.integration.test.ts",
            "apps/server/src/orchestration-v2/NativeAutoRouting.test.ts",
          ]
        : task.id === "05-followup"
          ? [
              "evals/native-auto/evaluate.test.ts",
              "apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.test.ts",
              "evals/native-auto/transport.test.ts",
            ]
          : ["evals/native-auto/evaluate.test.ts", "evals/native-auto/transport.test.ts"];
  const result = await command(
    "vp",
    ["test", "run", ...files],
    workspace,
    NodePath.join(currentDirectory, `check-${checkIndex}.log`),
  );
  if (!result.passed) return result;
  if (task.id === "01-mechanical") {
    const path = "apps/server/src/orchestration-v2/NativeAutoRouting.ts";
    const before = (
      await execFile("git", ["show", `${task.base}:${path}`], { cwd: workspace, env })
    ).stdout;
    const after = await NodeFSP.readFile(NodePath.join(workspace, path), "utf8");
    const changes = await captureChanges(workspace, task.base, env);
    return {
      passed:
        before.replaceAll(/\bAUTO_POLICY_VERSION\b/gu, "NATIVE_AUTO_POLICY_VERSION") === after &&
        changes.files.length === 1 &&
        changes.files[0] === path,
      feedback: "Expected only the requested private identifier rename.",
    };
  }
  if (task.id === "02-implementation") {
    const exported = NodePath.join(currentDirectory, `offline-${checkIndex}`);
    const ran = await command(
      process.execPath,
      ["native-auto/run.ts", "--out", exported, "--samples", "1"],
      NodePath.join(workspace, "evals"),
      NodePath.join(currentDirectory, `export-${checkIndex}.log`),
    );
    if (!ran.passed) return ran;
    return command(
      process.execPath,
      [NodePath.join(fixtures, "check-review-export.mjs"), exported],
      workspace,
      NodePath.join(currentDirectory, `oracle-${checkIndex}.log`),
    );
  }
  return result;
};
const program = Effect.gen(function* () {
  yield* initializeGuard;
  const sql = yield* SqlClient.SqlClient;
  yield* assertSettled();
  beforeIds = new Set(
    (yield* sql<{
      request_id: string;
    }>`SELECT request_id FROM native_auto_evaluation_reservations`).map((row) => row.request_id),
  );
  yield* runPilot({
    tasks,
    samples,
    assertSettled: () => assertSettled(),
    request: Effect.fn("NativeAutoPilot.classifyRequest")(function* (body: unknown) {
      const requestId = NodeCrypto.randomUUID();
      const config = { origin, pricing };
      yield* guard(config, {
        protocol_version: 2,
        operation: "reserve",
        request_id: requestId,
        method: "POST",
        origin,
        path: "/v1/decisions",
        model: "gpt-6-luna",
        service_tier: "default",
        cache_control_count: 0,
        max_output_tokens: null,
        tool_types: null,
      });
      const raw = paid ? yield* requestPaid(key!, "decisions", body) : yield* requestFixture(body);
      const usage = yield* decodeUsageEnvelope(raw);
      yield* guard(config, {
        protocol_version: 2,
        operation: "settle",
        request_id: requestId,
        response: {
          id: null,
          model: "gpt-6-luna",
          status: null,
          service_tier: "default",
          usage: usage.usage,
        },
      });
      return raw;
    }),
    prepare: (task, arm, sample) =>
      attempt("prepare", async () => {
        currentDirectory = NodePath.join(out, `${sample}-${arm}-${task.id}`);
        await NodeFSP.mkdir(currentDirectory, { mode: 0o700 });
        if (task.id === "05-followup") {
          checkIndex = 0;
          const red = await checks(task);
          if (red.passed || !red.feedback.includes("AssertionError"))
            throw new Error("Follow-up base did not reproduce the frozen accounting assertion");
          return;
        }
        workspace = NodePath.join(
          NodePath.dirname(repository),
          `t3code-pilot-${NodeCrypto.randomUUID()}`,
        );
        await execFile("git", ["worktree", "add", "--detach", workspace, task.base], {
          cwd: repository,
          env,
        });
        worktrees.push(workspace);
        const manifests = (
          await execFile("git", ["ls-files", "**/package.json"], { cwd: workspace, env })
        ).stdout
          .trim()
          .split("\n")
          .filter((path) => !path.startsWith(".repos/"));
        for (const relative of [
          "node_modules",
          ...manifests.map((path) => NodePath.join(NodePath.dirname(path), "node_modules")),
        ]) {
          const source = NodePath.join(repository, relative);
          try {
            await NodeFSP.access(source);
            await NodeFSP.symlink(source, NodePath.join(workspace, relative), "dir");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        }
        home = NodePath.join(currentDirectory, "home");
        await NodeFSP.mkdir(home, { mode: 0o700 });
        homes.push(home);
        if (paid)
          await NodeFSP.writeFile(
            NodePath.join(home, "auth.json"),
            JSON.stringify({ OPENAI_API_KEY: key }),
            { mode: 0o600 },
          );
        await NodeFSP.writeFile(
          NodePath.join(home, "config.toml"),
          paid
            ? 'service_tier = "default"\n'
            : `model_provider = "offline"\n[model_providers.offline]\nname = "Offline fixture"\nbase_url = "${origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 2\nstream_max_retries = 0\n`,
        );
        session = undefined;
        checkIndex = 0;
        started = performance.now();
        if (task.id === "03-debugging") {
          const red = await checks(task);
          if (
            red.passed ||
            !red.feedback.includes("AssertionError") ||
            !red.feedback.includes("gpt-6.1-sol")
          )
            throw new Error("Debugging base did not reproduce the expected frozen assertion");
        }
      }).pipe(Effect.uninterruptible),
    turn: (prompt, selection, resume) =>
      attempt("codex-turn", async (signal) => {
        const effort = selection.options?.find((option) => option.id === "reasoningEffort")?.value;
        if (resume && !session) throw new Error("Missing same-session continuation");
        await NodeFSP.writeFile(
          NodePath.join(currentDirectory, `route-${NodeCrypto.randomUUID()}.json`),
          JSON.stringify({ selection, resume, session }),
        );
        const args = [
          "exec",
          ...(resume ? ["resume", session!] : ["--sandbox", "workspace-write", "-C", workspace]),
          "--strict-config",
          "--ignore-rules",
          "--json",
          "-m",
          selection.model,
          "-c",
          `model_reasoning_effort="${effort}"`,
          "-c",
          'approval_policy="never"',
          "-c",
          'sandbox_mode="workspace-write"',
          "-",
        ];
        const child = NodeChildProcess.spawn(binary, args, {
          cwd: workspace,
          env: { ...env, HOME: home, CODEX_HOME: home, CODEX_REQUEST_GUARD: guardPath },
          signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        activeChild = child;
        activeClose = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        let stdout = "";
        let stderr = "";
        let overflow = false;
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > 8 * 1024 * 1024) {
            overflow = true;
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 1024 * 1024) {
            overflow = true;
            child.kill("SIGTERM");
          }
        });
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(
          `${prompt}\n\nWork only on the checked-out snapshot. Do not inspect later history, access credentials, change guard settings, launch other agents, or make provider API calls.\n`,
        );
        const code = await exited;
        activeChild = undefined;
        const index = NodeCrypto.randomUUID();
        await NodeFSP.writeFile(NodePath.join(currentDirectory, `${index}.stdout.jsonl`), stdout);
        await NodeFSP.writeFile(NodePath.join(currentDirectory, `${index}.stderr.log`), stderr);
        if (overflow || code !== 0) throw new Error("Codex failed; retain reservations and stop");
        const events = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        session = events.find((event) => event.type === "thread.started")?.thread_id ?? session;
        const answer = events
          .filter(
            (event) => event.type === "item.completed" && event.item?.type === "agent_message",
          )
          .map((event) => event.item.text)
          .join("\n");
        if (!answer) throw new Error("Missing final agent answer");
        return answer;
      }).pipe(
        Effect.timeout("3 minutes"),
        Effect.mapError((cause) => new EvaluationError({ stage: "codex-turn", cause })),
      ),
    check: (task) => attempt("fixed-checks", () => checks(task)),
    approveReview: (answer) =>
      attempt("review-gate", async () => {
        const path = NodePath.join(currentDirectory, "answer.txt");
        await NodeFSP.writeFile(path, answer);
        if (!values["review-gate"]) return false;
        return (
          await command(
            NodePath.resolve(values["review-gate"]),
            [path],
            workspace,
            NodePath.join(currentDirectory, "review-gate.log"),
          )
        ).passed;
      }),
    save: Effect.fn("NativeAutoPilot.save")(function* (result: PilotResult, sample: number) {
      const reservations = yield* sql<{
        request_id: string;
        maximum_microusd: number;
        actual_microusd: number | null;
      }>`SELECT * FROM native_auto_evaluation_reservations`;
      const own = reservations.filter((row) => !beforeIds.has(row.request_id));
      beforeIds = new Set(reservations.map((row) => row.request_id));
      const diff = yield* attempt(
        "capture-diff",
        async () => (await captureChanges(workspace, result.task.base, env)).diff,
      );
      const row = {
        ...result,
        sample,
        reservations: own,
        costMicroUsd: own.reduce(
          (sum, row) => sum + (row.actual_microusd ?? row.maximum_microusd),
          0,
        ),
        elapsedMs: performance.now() - started,
        diff,
      };
      rows.push(row);
      yield* attempt("save", async () => {
        await NodeFSP.appendFile(NodePath.join(out, "results.jsonl"), JSON.stringify(row) + "\n");
      });
      started = performance.now();
    }),
  });
});
await NodeFSP.writeFile(
  NodePath.join(out, "manifest.json"),
  JSON.stringify(
    {
      mode: paid ? "paid-native" : "offline-native-fixtures",
      binary,
      binaryHash,
      pricing,
      tasks,
      samples,
      limitations:
        "Historical replay, not representative savings or quality. Offline responses and costs are synthetic. Agent sandbox is not an adversarial containment boundary. Human blind review remains required.",
    },
    null,
    2,
  ),
);
try {
  await Effect.runPromise(program.pipe(Effect.provide(layer)), { signal: cancellation.signal });
} catch (cause) {
  process.exitCode = 1;
  await NodeFSP.writeFile(NodePath.join(out, "failure.txt"), String(cause));
} finally {
  activeChild?.kill("SIGTERM");
  await activeClose;
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  const shuffled = rows
    .map((row) => ({ row, key: NodeCrypto.randomUUID() }))
    .sort((a, b) => a.key.localeCompare(b.key));
  await NodeFSP.writeFile(
    NodePath.join(out, "review.json"),
    JSON.stringify(
      shuffled.map(({ row }, index) => ({
        reviewId: index + 1,
        caseId: row.task.id,
        prompt: row.task.prompt,
        rubric: row.task.rubric,
        history: row.history,
        answer: row.answer,
        diff: row.diff,
        correctness: null,
        requiredCorrections: null,
      })),
      null,
      2,
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(out, "answer-key.json"),
    JSON.stringify(
      shuffled.map(({ row }, index) => ({
        reviewId: index + 1,
        arm: row.arm,
        sample: row.sample,
        routes: row.routes,
      })),
      null,
      2,
    ),
  );
  const summary = {
    mode: paid ? "paid-native" : "offline-native-fixtures",
    complete:
      process.exitCode !== 1 &&
      rows.length === tasks.length * samples * 2 &&
      rows.every((row) => !row.blocked),
    rows: rows.length,
    objectivePassed: rows.filter((row) => row.passed === true).length,
    objectiveFailed: rows.filter((row) => row.passed === false).length,
    pendingHumanReview: rows.filter((row) => row.passed === null).length,
    blocked: rows.filter((row) => row.blocked).length,
    rollout: "inconclusive; Auto remains off",
  };
  await NodeFSP.writeFile(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  for (const path of homes) await NodeFSP.rm(NodePath.join(path, "auth.json"), { force: true });
  for (const path of worktrees)
    await execFile("git", ["worktree", "remove", "--force", path], { cwd: repository, env });
  if (!paid) await NodeFSP.copyFile(ledger, NodePath.join(out, "budget.sqlite"));
  await NodeFSP.rm(guardRuntime, { recursive: true, force: true });
}
