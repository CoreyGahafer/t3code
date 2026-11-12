import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import { EvaluationError, Pricing, tokenCost } from "./evaluate.ts";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Model = Schema.Literals(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Reserve = Schema.Struct({
  protocol_version: Schema.Literal(2),
  operation: Schema.Literal("reserve"),
  request_id: RequestId,
  method: Schema.Literal("POST"),
  origin: Schema.String,
  path: Schema.Literals(["/v1/responses", "/v1/responses/compact", "/v1/decisions"]),
  model: Model,
  service_tier: Schema.NullOr(Schema.Literal("default")),
  cache_control_count: Schema.Literal(0),
  max_output_tokens: Schema.NullOr(Count),
  tool_types: Schema.NullOr(Schema.Array(Schema.Literals(["function", "custom", "namespace"]))),
});
const Usage = Schema.Struct({ input_tokens: Count, output_tokens: Count });
const Receipt = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  model: Model,
  status: Schema.NullOr(Schema.Literals(["completed", "incomplete", "failed"])),
  service_tier: Schema.Literal("default"),
  usage: Usage,
});
const Settle = Schema.Struct({
  protocol_version: Schema.Literal(2),
  operation: Schema.Literal("settle"),
  request_id: RequestId,
  response: Receipt,
});
const Metadata = Schema.Struct({
  model: Model,
  pricing: Pricing,
  maximumOutputTokens: Count,
});
const decodeInput = Schema.decodeUnknownEffect(Schema.Union([Reserve, Settle]));
const encodeMetadata = Schema.encodeEffect(Schema.fromJsonString(Metadata));
const decodeMetadata = Schema.decodeEffect(Schema.fromJsonString(Metadata));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));

export const initializeGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS native_auto_pilot_receipts (
    request_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, response TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS native_auto_pilot_state (
    id INTEGER PRIMARY KEY CHECK(id = 1), halted INTEGER NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO native_auto_pilot_state VALUES (1, 0)`;
});

export const guard = Effect.fn("NativeAutoPilot.guard")(
  function* (
    config: { readonly origin: string; readonly pricing: typeof Pricing.Type },
    raw: unknown,
  ) {
    const input = yield* decodeInput(raw);
    const budget = yield* Budget.NativeAutoEvaluationBudget;
    const sql = yield* SqlClient.SqlClient;
    const approved = yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* sql<{
          halted: number;
        }>`SELECT halted FROM native_auto_pilot_state WHERE id = 1`;
        if (state[0]?.halted !== 0) return false;
        if (input.operation === "reserve") {
          if (input.origin !== config.origin) return false;
          if (input.service_tier === null && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(config.origin))
            return false;
          const pending = yield* sql`SELECT request_id FROM native_auto_evaluation_reservations
            WHERE actual_microusd IS NULL LIMIT 1`;
          if (pending.length > 0) return false;
          const price = config.pricing.models[input.model];
          const maximumOutputTokens = input.max_output_tokens ?? price.maximumOutputTokens;
          if (maximumOutputTokens < 1 || maximumOutputTokens > price.maximumOutputTokens)
            return false;
          const maximumMicroUsd = tokenCost(
            { input_tokens: price.maximumInputTokens, output_tokens: maximumOutputTokens },
            price,
          );
          if (maximumMicroUsd > 25_000_000) return false;
          const accepted = yield* budget.reserve({
            approved: true,
            requestId: input.request_id,
            pricingRevision: config.pricing.revision,
            maximumMicroUsd,
          });
          if (!accepted) return false;
          yield* sql`INSERT INTO native_auto_pilot_receipts (request_id, metadata) VALUES
            (${input.request_id}, ${yield* encodeMetadata({ model: input.model, pricing: config.pricing, maximumOutputTokens })})`;
          return true;
        }
        const rows = yield* sql<{
          metadata: string;
          response: string | null;
          maximum_microusd: number;
        }>`
          SELECT metadata, response, maximum_microusd FROM native_auto_pilot_receipts
          JOIN native_auto_evaluation_reservations USING (request_id) WHERE request_id = ${input.request_id}`;
        const row = rows[0];
        const response = yield* encodeReceipt(input.response);
        if (!row || (row.response !== null && row.response !== response)) {
          yield* sql`UPDATE native_auto_pilot_state SET halted = 1 WHERE id = 1`;
          return false;
        }
        if (row.response === response) return true;
        const metadata = yield* decodeMetadata(row.metadata);
        const price = metadata.pricing.models[metadata.model];
        if (input.response.model !== metadata.model) return false;
        const actualMicroUsd = tokenCost(input.response.usage, price);
        if (
          actualMicroUsd > row.maximum_microusd ||
          input.response.usage.input_tokens > price.maximumInputTokens ||
          input.response.usage.output_tokens > metadata.maximumOutputTokens
        ) {
          if (actualMicroUsd > row.maximum_microusd)
            yield* budget.reconcile({ requestId: input.request_id, actualMicroUsd });
          yield* sql`UPDATE native_auto_pilot_state SET halted = 1 WHERE id = 1`;
          return false;
        }
        yield* budget.reconcile({ requestId: input.request_id, actualMicroUsd });
        yield* sql`UPDATE native_auto_pilot_receipts SET response = ${response} WHERE request_id = ${input.request_id}`;
        return true;
      }),
    );
    if (!approved) return yield* new EvaluationError({ stage: "guard-denied" });
    return {
      protocol_version: input.protocol_version,
      operation: input.operation,
      request_id: input.request_id,
    };
  },
  Effect.mapError((cause) => new EvaluationError({ stage: "guard", cause })),
);
