import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class EvaluationBudgetError extends Schema.TaggedError<EvaluationBudgetError>()(
  "EvaluationBudgetError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Evaluation reservation failed; do not dispatch the request.";
  }
}

const Reservation = Schema.Struct({
  approved: Schema.Literal(true),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  pricingRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  maximumMicroUsd: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(25_000_000),
  ),
});
const Reconciliation = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  actualMicroUsd: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
const decodeReservation = Schema.decodeUnknownEffect(Reservation);
const decodeReconciliation = Schema.decodeUnknownEffect(Reconciliation);

export class NativeAutoEvaluationBudget extends Context.Service<
  NativeAutoEvaluationBudget,
  {
    readonly reserve: (
      input: typeof Reservation.Type,
    ) => Effect.Effect<boolean, EvaluationBudgetError>;
    readonly reconcile: (
      input: typeof Reconciliation.Type,
    ) => Effect.Effect<void, EvaluationBudgetError>;
  }
>()("t3/orchestration-v2/NativeAutoEvaluationBudget") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reserve = Effect.fn("NativeAutoEvaluationBudget.reserve")(
    function* (raw: typeof Reservation.Type) {
      const input = yield* decodeReservation(raw);
      // One atomic insert counts every in-flight or ambiguous request against the pilot ceiling.
      const rows = yield* sql`INSERT INTO native_auto_evaluation_reservations
      (request_id, pricing_revision, maximum_microusd)
      SELECT ${input.requestId}, ${input.pricingRevision}, ${input.maximumMicroUsd}
      WHERE (SELECT COALESCE(SUM(COALESCE(actual_microusd, maximum_microusd)), 0)
        FROM native_auto_evaluation_reservations) + ${input.maximumMicroUsd} <= 25000000
      ON CONFLICT(request_id) DO NOTHING RETURNING request_id`;
      return rows.length === 1;
    },
    Effect.mapError((cause) => new EvaluationBudgetError({ cause })),
  );
  const reconcile = Effect.fn("NativeAutoEvaluationBudget.reconcile")(
    function* (raw: typeof Reconciliation.Type) {
      const input = yield* decodeReconciliation(raw);
      yield* sql`UPDATE native_auto_evaluation_reservations SET actual_microusd = ${input.actualMicroUsd}
      WHERE request_id = ${input.requestId} AND actual_microusd IS NULL`;
    },
    Effect.mapError((cause) => new EvaluationBudgetError({ cause })),
  );
  return NativeAutoEvaluationBudget.of({ reserve, reconcile });
});
export const layer = Layer.effect(NativeAutoEvaluationBudget, make);
