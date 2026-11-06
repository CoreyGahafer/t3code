import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Budget from "./NativeAutoEvaluationBudget.ts";

it.effect(
  "atomically counts in-flight requests, forbids duplicate dispatch and retains ambiguous spend",
  () =>
    Effect.gen(function* () {
      const ledger = yield* Budget.NativeAutoEvaluationBudget;
      const reserve = (requestId: string, maximumMicroUsd: number) =>
        ledger.reserve({
          approved: true,
          requestId,
          maximumMicroUsd,
          pricingRevision: "fixture-prices",
        });
      const results = yield* Effect.all([reserve("a", 15_000_000), reserve("b", 15_000_000)], {
        concurrency: "unbounded",
      });
      assert.equal(results.filter(Boolean).length, 1);
      const winner = results[0] ? "a" : "b";
      assert.isFalse(yield* reserve(winner, 1));
      assert.isFalse(yield* reserve("ambiguous-retry", 15_000_000));
      yield* ledger.reconcile({ requestId: winner, actualMicroUsd: 1_000_000 });
      assert.isTrue(yield* reserve("after-reconciliation", 24_000_000));
      yield* ledger.reconcile({ requestId: winner, actualMicroUsd: 0 });
      assert.isFalse(yield* reserve("cannot-refund-twice", 1));
    }).pipe(Effect.provide(Layer.provide(Budget.layer, Sqlite.layerMemory))),
);
