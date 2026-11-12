import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import * as Sqlite from "../../apps/server/src/persistence/Sqlite.ts";
import { evaluate, EvaluationError, Pricing, tokenCost, type EvaluationRow } from "./evaluate.ts";

const decodePricing = Schema.decodeSync(Pricing);
const decodeRequestModel = Schema.decodeUnknownEffect(Schema.Struct({ model: Schema.String }));

const price = {
  inputMicroUsdPerMillion: 1000000,
  outputMicroUsdPerMillion: 2000000,
  maximumInputTokens: 100,
  maximumOutputTokens: 100,
};
const pricing = {
  revision: "fixture",
  models: { "gpt-6-luna": price, "gpt-6.1-sol": price, "gpt-6-astra": price },
};
const fixture = {
  id: "edit",
  source: "test",
  prompt: "fix",
  rubric: "passes",
  sourceCode: "broken",
  testCode: "test",
};
const response = {
  status: "completed",
  usage: { input_tokens: 5, output_tokens: 3 },
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: '{"answer":"fixed","sourceCode":"fixed"}' }],
    },
  ],
};
const layer = Budget.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it("prices input and output conservatively without cache discounts or rounding loss", () => {
  assert.equal(tokenCost({ input_tokens: 5, output_tokens: 3 }, price), 11);
  assert.equal(
    tokenCost({ input_tokens: 1, output_tokens: 0 }, { ...price, inputMicroUsdPerMillion: 1 }),
    1,
  );
  assert.throws(() =>
    decodePricing({
      ...pricing,
      models: { ...pricing.models, "gpt-6-luna": { ...price, inputMicroUsdPerMillion: -1 } },
    }),
  );
});

it.effect(
  "compares saved profile choices with baseline, includes classification cost and alternates arms",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const saved: EvaluationRow[] = [];
      const rows = yield* evaluate({
        runId: "test",
        cases: [fixture],
        samples: 2,
        pricing,
        maximumOutputTokens: 10,
        request: (endpoint, body) =>
          Effect.gen(function* () {
            const { model } = yield* decodeRequestModel(body).pipe(
              Effect.mapError(() => new EvaluationError({ stage: "test-body" })),
            );
            calls.push(`${endpoint}:${model}`);
            return endpoint === "decisions"
              ? {
                  answers: [{ type: "choice", name: "route", choice: "mechanical" }],
                  usage: { input_tokens: 5, output_tokens: 0 },
                }
              : response;
          }),
        verify: (_, code) => Effect.succeed(code === "fixed"),
        save: (row) =>
          Effect.sync(() => {
            saved.push(row);
          }),
      });
      assert.deepEqual(
        rows.map((row) => row.arm),
        ["auto", "baseline", "baseline", "auto"],
      );
      assert.deepEqual(
        rows.map((row) => row.model),
        ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra", "gpt-6.1-sol"],
      );
      assert.deepEqual(
        rows.map((row) => row.costMicroUsd),
        [16, 11, 11, 16],
      );
      assert.isTrue(rows.every((row) => row.passed && row.status === "completed"));
      assert.lengthOf(calls, 6);
      assert.deepEqual(saved, rows);
      assert.deepEqual(rows[0]?.usage, { inputTokens: 10, outputTokens: 3 });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "stops on ambiguous classifier failures, missing usage, and exceeded pricing bounds without replay",
  () =>
    Effect.gen(function* () {
      for (const mode of ["transport", "usage", "bounds", "excess-cost"] as const) {
        const rows: EvaluationRow[] = [];
        let calls = 0;
        const run = evaluate({
          runId: "test",
          cases: [{ ...fixture, id: mode }],
          samples: 1,
          pricing,
          maximumOutputTokens: 10,
          request: () => {
            calls++;
            return mode === "transport"
              ? Effect.fail(new EvaluationError({ stage: "transport" }))
              : Effect.succeed({
                  answers: [{ type: "choice", name: "route", choice: "mechanical" }],
                  ...(mode === "usage"
                    ? {}
                    : {
                        usage: {
                          input_tokens: mode === "excess-cost" ? 1000 : 101,
                          output_tokens: 0,
                        },
                      }),
                });
          },
          verify: () => Effect.die("must not execute"),
          save: (row) =>
            Effect.sync(() => {
              rows.push(row);
            }),
        });
        yield* run.pipe(Effect.flip);
        assert.equal(calls, 1);
        assert.equal(rows[0]?.costMicroUsd, null);
        assert.equal(rows[0]?.status, "failed");
        const sql = yield* SqlClient.SqlClient;
        const reserved = yield* sql<{
          maximum_microusd: number;
          actual_microusd: number | null;
        }>`SELECT maximum_microusd, actual_microusd FROM native_auto_evaluation_reservations WHERE request_id = ${`test:${mode}:0:auto:decisions`}`;
        assert.equal(reserved[0]?.maximum_microusd, 300);
        assert.equal(reserved[0]?.actual_microusd, mode === "excess-cost" ? 1000 : null);
        yield* run.pipe(Effect.flip);
        assert.equal(calls, 1);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains ambiguous execution spend and never grades a truncated response as a success",
  () =>
    Effect.gen(function* () {
      for (const mode of ["missing-usage", "incomplete"] as const) {
        const rows: EvaluationRow[] = [];
        let verified = false;
        const run = yield* evaluate({
          runId: "test",
          cases: [{ ...fixture, id: mode }],
          samples: 1,
          pricing,
          maximumOutputTokens: 10,
          request: (endpoint) =>
            Effect.succeed(
              endpoint === "decisions"
                ? {
                    answers: [{ type: "choice", name: "route", choice: "implementation" }],
                    usage: { input_tokens: 5, output_tokens: 0 },
                  }
                : mode === "missing-usage"
                  ? {}
                  : { ...response, status: "incomplete" },
            ),
          verify: () =>
            Effect.sync(() => {
              verified = true;
              return true;
            }),
          save: (row) =>
            Effect.sync(() => {
              rows.push(row);
            }),
        }).pipe(Effect.result);
        assert.isFalse(verified);
        assert.equal(rows[0]?.status, "failed");
        assert.equal(run._tag, mode === "missing-usage" ? "Failure" : "Success");
        assert.equal(rows[0]?.costMicroUsd, mode === "missing-usage" ? null : 16);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("interruption leaves the reservation held and does not dispatch another request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const run = evaluate({
      runId: "test",
      cases: [fixture],
      samples: 1,
      pricing,
      maximumOutputTokens: 10,
      request: () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      verify: () => Effect.die("must not execute"),
      save: () => Effect.void,
    });
    const fiber = yield* run.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* run.pipe(Effect.flip);
    assert.equal(calls, 1);
  }).pipe(Effect.provide(layer)),
);
