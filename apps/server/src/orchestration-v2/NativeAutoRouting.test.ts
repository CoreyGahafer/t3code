import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  autoSelection,
  boundedAutoContext,
  classifyAuto,
  requireConcreteCodexModel,
} from "./NativeAutoRouting.ts";

const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "t3-auto",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "default" },
  ],
};
const messages = [
  { role: "user" as const, text: "Rename the constant to MAX_SIZE", attachmentCount: 0 },
];

it("keeps the paid feature disabled and prevents an alias reaching Codex", () => {
  assert.throws(() => requireConcreteCodexModel("t3-auto"), /disabled pending evaluation/);
  requireConcreteCodexModel("gpt-6.1-sol");
  assert.deepEqual(autoSelection(selection, "baseline"), {
    ...selection,
    model: "gpt-6-astra",
    options: [
      { id: "serviceTier", value: "default" },
      { id: "reasoningEffort", value: "medium" },
    ],
  });
});

it.effect("validates the frozen choices and overrides explicit effort", () =>
  Effect.gen(function* () {
    for (const choice of ["mechanical", "implementation", "baseline", "new-catalog-model"]) {
      const result = yield* classifyAuto({
        selection,
        messages,
        request: () => Effect.succeed({ answers: [{ type: "choice", name: "route", choice }] }),
      });
      assert.equal(
        result.selection.model,
        choice === "mechanical" || choice === "implementation" ? "gpt-6.1-sol" : "gpt-6-astra",
      );
      assert.equal(
        result.selection.options?.at(-1)?.value,
        choice === "mechanical" ? "low" : "medium",
      );
      assert.equal(
        result.fallback,
        choice === "new-catalog-model" ? "classification-failed" : null,
      );
    }
  }),
);

it.effect("uses baseline without classification for missing or incomplete evidence", () =>
  Effect.gen(function* () {
    for (const context of [
      [],
      [{ ...messages[0]!, text: "x".repeat(4001) }],
      [{ ...messages[0]!, attachmentCount: 2 }],
    ]) {
      const result = yield* classifyAuto({
        selection,
        messages: context,
        request: () => Effect.die("must not classify"),
      });
      assert.equal(result.fallback, "insufficient-context");
      assert.equal(result.selection.model, "gpt-6-astra");
    }
    const context = boundedAutoContext([
      ...messages,
      { role: "assistant", text: "The plan changes the parser", attachmentCount: 0 },
      { ...messages[0]!, text: "implement that" },
    ]);
    assert.equal(context?.length, 3);
    assert.include(context?.[1]?.content ?? "", "changes the parser");
  }),
);

it.effect("aborts classification at the deadline without retrying", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const fiber = yield* classifyAuto({
      selection,
      messages,
      request: () =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1);
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          );
        }),
    }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    yield* Deferred.await(interrupted);
    assert.equal(result.fallback, "classification-failed");
    assert.equal(yield* Ref.get(calls), 1);
  }),
);

it.effect("cancellation propagates instead of selecting a fallback or retrying", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const fiber = yield* classifyAuto({
      selection,
      messages,
      request: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
        }),
    }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(cancelled);
  }),
);
