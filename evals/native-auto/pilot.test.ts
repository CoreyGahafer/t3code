import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runPilot, type PilotResult } from "./pilot.ts";
import { EvaluationError } from "./evaluate.ts";

it.effect(
  "preserves review context and sessions, classifies new corrections and alternates arms",
  () =>
    Effect.gen(function* () {
      const turns: boolean[] = [];
      const prompts: unknown[] = [];
      const prepared: string[] = [];
      const saved: PilotResult[] = [];
      let checks = 0;
      yield* runPilot({
        tasks: ["01-mechanical", "04-review", "05-followup"].map((id) => ({
          id,
          base: "base",
          prompt: id,
          rubric: "correct",
        })),
        samples: 2,
        request: (body) =>
          Effect.sync(() => {
            prompts.push(body);
            return { answers: [{ type: "choice", name: "route", choice: "mechanical" }] };
          }),
        assertSettled: () => Effect.void,
        prepare: (task) =>
          Effect.sync(() => {
            prepared.push(task.id);
          }),
        turn: (_, __, resume) =>
          Effect.sync(() => {
            turns.push(resume);
            return "confirmed finding";
          }),
        check: () =>
          Effect.sync(() => ({
            passed: ++checks !== 1,
            feedback: "fixed assertion failed",
          })),
        approveReview: () => Effect.succeed(true),
        save: (row) =>
          Effect.sync(() => {
            saved.push(row);
          }),
      });
      assert.deepEqual(
        saved.map((row) => row.arm),
        [
          "auto",
          "auto",
          "auto",
          "baseline",
          "baseline",
          "baseline",
          "baseline",
          "baseline",
          "baseline",
          "auto",
          "auto",
          "auto",
        ],
      );
      assert.deepEqual(turns.slice(0, 4), [false, true, false, true]);
      assert.equal(prepared.filter((id) => id === "05-followup").length, 4);
      assert.equal(saved[0]?.attempts, 2);
      assert.equal(saved[2]?.history.at(-1)?.text, "confirmed finding");
      assert.equal(prompts.length, 7);
    }),
);

it.effect(
  "blocks follow-ups without a confirmed review and stops after ambiguous classification",
  () =>
    Effect.gen(function* () {
      const saved: PilotResult[] = [];
      let turns = 0;
      let ambiguous = false;
      const task = (id: string) => ({ id, base: "base", prompt: id, rubric: "correct" });
      const input = {
        tasks: [task("04-review"), task("05-followup")],
        samples: 1,
        request: () => Effect.fail(new EvaluationError({ stage: "ambiguous-dispatch" })),
        assertSettled: () =>
          ambiguous ? Effect.fail(new EvaluationError({ stage: "held-reservation" })) : Effect.void,
        prepare: () => Effect.void,
        turn: () =>
          Effect.sync(() => {
            turns++;
            return "no finding";
          }),
        check: () => Effect.succeed({ passed: null, feedback: "" }),
        approveReview: () => Effect.succeed(false),
        save: (row: PilotResult) =>
          Effect.sync(() => {
            saved.push(row);
          }),
      };
      yield* runPilot(input);
      assert.equal(turns, 2);
      assert.isTrue(saved[1]!.blocked);
      assert.isTrue(saved[3]!.blocked);
      ambiguous = true;
      yield* runPilot(input).pipe(Effect.flip);
      assert.equal(turns, 2);
    }),
);
