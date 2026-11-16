import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import * as Sqlite from "../../apps/server/src/persistence/Sqlite.ts";
import { guard, initializeGuard } from "./guard.ts";

const price = {
  inputMicroUsdPerMillion: 1000000,
  outputMicroUsdPerMillion: 2000000,
  maximumInputTokens: 100,
  maximumOutputTokens: 100,
};
const config = {
  origin: "https://api.openai.com",
  pricing: {
    revision: "synthetic-test",
    models: { "gpt-6-luna": price, "gpt-6.1-sol": price, "gpt-6-astra": price },
  },
};
const reserve = {
  protocol_version: 2,
  operation: "reserve",
  request_id: "test",
  method: "POST",
  origin: config.origin,
  path: "/v1/responses",
  model: "gpt-6.1-sol",
  max_output_tokens: null,
  service_tier: "default",
  cache_control_count: 0,
  tool_types: ["function"],
};
const settle = {
  protocol_version: 2,
  operation: "settle",
  request_id: "test",
  response: {
    id: "response-1",
    model: "gpt-6.1-sol",
    status: "completed",
    service_tier: "default",
    usage: { input_tokens: 5, output_tokens: 3 },
  },
};
const layer = Budget.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("acknowledges settlement once and retains ambiguous or invalid reservations", () =>
  Effect.gen(function* () {
    yield* initializeGuard;
    const sql = yield* SqlClient.SqlClient;
    yield* guard(config, reserve);
    assert.isTrue(
      Exit.isFailure(yield* guard(config, { ...settle, response: {} }).pipe(Effect.exit)),
    );
    const ambiguous = yield* sql`SELECT actual_microusd FROM native_auto_evaluation_reservations`;
    assert.equal(ambiguous[0]?.actual_microusd, null);
    assert.isTrue(Exit.isFailure(yield* guard(config, reserve).pipe(Effect.exit)));
    assert.isTrue(
      Exit.isFailure(yield* guard(config, { ...reserve, request_id: "overlap" }).pipe(Effect.exit)),
    );
    yield* guard(config, settle);
    yield* guard(config, settle);
    const rows = yield* sql`SELECT * FROM native_auto_evaluation_reservations`;
    assert.equal(rows[0]?.actual_microusd, 11);
    yield* guard(config, { ...reserve, request_id: "second" });
    const invalid = {
      ...settle,
      request_id: "second",
      response: { ...settle.response, usage: { input_tokens: 101, output_tokens: 0 } },
    };
    assert.isTrue(Exit.isFailure(yield* guard(config, invalid).pipe(Effect.exit)));
    const held =
      yield* sql`SELECT * FROM native_auto_evaluation_reservations WHERE request_id = 'second'`;
    assert.equal(held[0]?.actual_microusd, null);
    assert.isTrue(
      Exit.isFailure(yield* guard(config, { ...reserve, request_id: "third" }).pipe(Effect.exit)),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "admits one overlapping attempt and freezes conflicting receipts without rewriting actuals",
  () =>
    Effect.gen(function* () {
      yield* initializeGuard;
      const sql = yield* SqlClient.SqlClient;
      const admissions = yield* Effect.forEach(
        ["first", "second"],
        (request_id) => guard(config, { ...reserve, request_id }).pipe(Effect.exit),
        { concurrency: "unbounded" },
      );
      assert.equal(admissions.filter(Exit.isSuccess).length, 1);
      const rows = yield* sql<{
        request_id: string;
      }>`SELECT request_id FROM native_auto_evaluation_reservations`;
      const request_id = rows[0]!.request_id;
      yield* guard(config, { ...settle, request_id });
      assert.isTrue(
        Exit.isFailure(
          yield* guard(config, {
            ...settle,
            request_id,
            response: { ...settle.response, usage: { input_tokens: 1, output_tokens: 0 } },
          }).pipe(Effect.exit),
        ),
      );
      const actual = yield* sql`SELECT actual_microusd FROM native_auto_evaluation_reservations`;
      assert.equal(actual[0]?.actual_microusd, 11);
      assert.isTrue(
        Exit.isFailure(yield* guard(config, { ...reserve, request_id: "later" }).pipe(Effect.exit)),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects unfundable requests and records known excess without refunding ambiguity", () =>
  Effect.gen(function* () {
    yield* initializeGuard;
    const sql = yield* SqlClient.SqlClient;
    for (const input of [
      { ...reserve, origin: "https://example.com" },
      { ...reserve, service_tier: "priority" },
      { ...reserve, tool_types: ["web_search"] },
      { ...reserve, max_output_tokens: 101 },
      { ...reserve, protocol_version: 1 },
      { ...reserve, cache_control_count: 1 },
      { ...reserve, service_tier: null },
    ]) {
      assert.isTrue(Exit.isFailure(yield* guard(config, input).pipe(Effect.exit)));
    }
    const expensive = {
      ...price,
      inputMicroUsdPerMillion: 50_000_000,
      outputMicroUsdPerMillion: 75_000_000,
      maximumInputTokens: 922_000,
      maximumOutputTokens: 128_000,
    };
    assert.isTrue(
      Exit.isFailure(
        yield* guard(
          {
            ...config,
            pricing: {
              ...config.pricing,
              models: { ...config.pricing.models, "gpt-6-astra": expensive },
            },
          },
          { ...reserve, model: "gpt-6-astra" },
        ).pipe(Effect.exit),
      ),
    );
    yield* guard(config, reserve);
    assert.isTrue(
      Exit.isFailure(
        yield* guard(config, {
          ...settle,
          response: { ...settle.response, usage: { input_tokens: 500, output_tokens: 1 } },
        }).pipe(Effect.exit),
      ),
    );
    const rows = yield* sql`SELECT * FROM native_auto_evaluation_reservations`;
    assert.equal(rows[0]?.actual_microusd, 502);
    assert.isTrue(
      Exit.isFailure(yield* guard(config, { ...reserve, request_id: "later" }).pipe(Effect.exit)),
    );
  }).pipe(Effect.provide(layer)),
);
