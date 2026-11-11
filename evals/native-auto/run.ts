#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import createBudgetTable from "../../apps/server/src/persistence/Migrations/082_NativeAutoEvaluationBudget.ts";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import { cases } from "./cases.ts";
import { requestPaid } from "./transport.ts";
import {
  evaluate,
  EvaluationError,
  Pricing,
  type EvaluationCase,
  type EvaluationRow,
} from "./evaluate.ts";

const decodeOfflineInput = Schema.decodeUnknownEffect(
  Schema.Struct({ input: Schema.Array(Schema.Struct({ content: Schema.String })) }),
);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    paid: { type: "boolean", default: false },
    "approve-astra": { type: "boolean", default: false },
    pricing: { type: "string" },
    "max-output-tokens": { type: "string", default: "4096" },
  },
});
if (!values.out)
  throw new Error(
    "Use --out <new-directory>. Default mode is offline; paid runs require --paid --approve-astra --pricing <file>.",
  );
const selected = cases.filter(
  (fixture) => !values.case || values.case.split(",").includes(fixture.id),
);
if (
  selected.length === 0 ||
  (values.case && values.case.split(",").some((id) => !cases.some((fixture) => fixture.id === id)))
)
  throw new Error("Unknown case.");
const samples = Number(values.samples);
const maximumOutputTokens = Number(values["max-output-tokens"]);
if (
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  samples > 10 ||
  !Number.isSafeInteger(maximumOutputTokens) ||
  maximumOutputTokens < 1 ||
  maximumOutputTokens > 32768
)
  throw new Error("Use 1–10 samples and 1–32768 output tokens.");
const paid = values.paid;
if (
  paid &&
  (!values["approve-astra"] ||
    !values.pricing ||
    !process.env.OPENAI_API_KEY ||
    process.env.OPENAI_BASE_URL)
)
  throw new Error(
    "Paid mode requires explicit Astra approval, a pricing file, OPENAI_API_KEY and the standard OpenAI endpoint.",
  );
const key = paid ? process.env.OPENAI_API_KEY : undefined;
const syntheticPrice = {
  inputMicroUsdPerMillion: 1000000,
  outputMicroUsdPerMillion: 2000000,
  maximumInputTokens: 128000,
  maximumOutputTokens: 32768,
};
const pricing = Schema.decodeUnknownSync(Pricing)(
  paid
    ? JSON.parse(await NodeFSP.readFile(values.pricing!, "utf8"))
    : {
        revision: "synthetic-offline-not-billing",
        models: {
          "gpt-6-luna": syntheticPrice,
          "gpt-6.1-sol": syntheticPrice,
          "gpt-6-astra": syntheticPrice,
        },
      },
);
if (Object.values(pricing.models).some((price) => price.maximumOutputTokens < maximumOutputTokens))
  throw new Error("Output limit exceeds pricing bounds.");
const outputDirectory = NodePath.resolve(values.out);
await NodeFSP.mkdir(NodePath.dirname(outputDirectory), { recursive: true });
// Exclusive creation prevents a rerun from overwriting evidence or replaying ambiguous requests.
await NodeFSP.mkdir(outputDirectory, { mode: 0o700 });
const ledgerDirectory = NodePath.resolve(import.meta.dirname, "../runs");
if (paid) await NodeFSP.mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
const database = NodeSqliteClient.layer({
  filename: paid ? NodePath.join(ledgerDirectory, "native-auto-budget.sqlite") : ":memory:",
});
const budgetLayer = Budget.layer.pipe(
  Layer.provide(Layer.effectDiscard(createBudgetTable).pipe(Layer.provideMerge(database))),
);
const request = Effect.fn("NativeAutoEvaluation.transport")(
  function* (endpoint: "decisions" | "responses", body: unknown) {
    if (!paid) {
      const decoded = yield* decodeOfflineInput(body).pipe(
        Effect.mapError(() => new EvaluationError({ stage: "offline-input" })),
      );
      const current = decoded.input.at(-1)?.content ?? "";
      const fixture = selected.find((candidate) => current.startsWith(candidate.prompt));
      if (!fixture) return yield* new EvaluationError({ stage: "offline-fixture" });
      const usage = { input_tokens: 100, output_tokens: 20 };
      return endpoint === "decisions"
        ? { answers: [{ type: "choice", name: "route", choice: fixture.route }], usage }
        : {
            status: "completed",
            usage,
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: yield* encodeReport({
                      answer: fixture.rubric,
                      sourceCode: "solution" in fixture ? fixture.solution : "",
                    }),
                  },
                ],
              },
            ],
          };
    }
    return yield* requestPaid(key!, endpoint, body);
  },
  Effect.mapError(() => new EvaluationError({ stage: "transport" })),
);
const verify = Effect.fn("NativeAutoEvaluation.verify")(function* (
  fixture: EvaluationCase,
  sourceCode: string,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const directory = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-auto-eval-")),
      );
      try {
        await NodeFSP.writeFile(NodePath.join(directory, "package.json"), '{"type":"module"}');
        await NodeFSP.writeFile(NodePath.join(directory, "source.mjs"), sourceCode);
        await NodeFSP.writeFile(NodePath.join(directory, "verify.mjs"), fixture.testCode ?? "");
        try {
          await NodeUtil.promisify(NodeChildProcess.execFile)(
            process.execPath,
            [
              "--permission",
              `--allow-fs-read=${directory}`,
              NodePath.join(directory, "verify.mjs"),
            ],
            { cwd: directory, env: {}, signal, timeout: 10000, maxBuffer: 65536 },
          );
          return true;
        } catch (error) {
          if (signal.aborted) throw error;
          return false;
        }
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
    catch: () => new EvaluationError({ stage: "isolated-verification" }),
  });
});
if (!paid) {
  for (const fixture of selected) {
    if ("sourceCode" in fixture && (await Effect.runPromise(verify(fixture, fixture.sourceCode)))) {
      throw new Error(`Fixture ${fixture.id} does not fail before its correction.`);
    }
  }
}
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
await NodeFSP.writeFile(
  NodePath.join(outputDirectory, "manifest.json"),
  encode({
    mode: paid ? "paid-api" : "offline-fixtures",
    pricing,
    samples,
    maximumOutputTokens,
    cases: selected,
    limitations:
      "Synthetic isolated source tasks and open-ended answers. Not a Codex agent benchmark, real-repository quality proof, invoice reconciliation, or rollout approval. One attempt per arm; failed objective checks require corrective work that is not measured here.",
  }),
);
const rows: EvaluationRow[] = [];
const program = evaluate({
  runId: NodeCrypto.randomUUID(),
  cases: selected,
  samples,
  pricing,
  maximumOutputTokens,
  request,
  verify,
  save: Effect.fn("NativeAutoEvaluation.save")(function* (row: EvaluationRow) {
    const text = yield* encodeReport(row).pipe(
      Effect.mapError(() => new EvaluationError({ stage: "encode-row" })),
    );
    yield* Effect.tryPromise({
      try: () => NodeFSP.appendFile(NodePath.join(outputDirectory, "results.jsonl"), text + "\n"),
      catch: () => new EvaluationError({ stage: "save" }),
    });
    rows.push(row);
  }),
});
try {
  await Effect.runPromise(program.pipe(Effect.provide(budgetLayer)));
} catch {
  process.exitCode = 1;
} finally {
  const shuffled = rows
    .map((row) => ({ row, key: NodeCrypto.randomUUID() }))
    .sort((a, b) => a.key.localeCompare(b.key));
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "review.json"),
    encode(
      shuffled.map(({ row }, index) => ({
        reviewId: index + 1,
        caseId: row.id,
        sample: row.sample,
        rubric: selected.find((fixture) => fixture.id === row.id)?.rubric,
        answer: row.answer,
        sourceCode: row.sourceCode,
        correctness: null,
        requiredCorrections: null,
        notes: "",
      })),
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "answer-key.json"),
    encode(
      shuffled.map(({ row }, index) => ({
        reviewId: index + 1,
        arm: row.arm,
        model: row.model,
        effort: row.effort,
      })),
    ),
  );
  const summary = {
    mode: paid ? "paid-api" : "offline-fixtures",
    complete: rows.length === selected.length * samples * 2 && process.exitCode !== 1,
    rollout: "inconclusive; Auto remains off",
    rows: rows.length,
    arms: ["auto", "baseline"].map((arm) => {
      const armRows = rows.filter((row) => row.arm === arm);
      return {
        arm,
        completed: armRows.filter((row) => row.status === "completed").length,
        objectivePassed: armRows.filter((row) => row.passed === true).length,
        objectiveFailed: armRows.filter((row) => row.passed === false).length,
        humanReviewRequired: armRows.filter((row) => row.passed === null).length,
        latencyMs: armRows.reduce((total, row) => total + row.latencyMs, 0),
        costMicroUsd: armRows.some((row) => row.costMicroUsd === null)
          ? null
          : armRows.reduce((total, row) => total + (row.costMicroUsd ?? 0), 0),
      };
    }),
  };
  await NodeFSP.writeFile(NodePath.join(outputDirectory, "summary.json"), encode(summary));
  process.stdout.write(encode(summary));
}
