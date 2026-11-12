import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  autoSelection,
  classifyAuto,
  type AutoContextMessage,
} from "../../apps/server/src/orchestration-v2/NativeAutoRouting.ts";

export interface PilotTask {
  readonly id: string;
  readonly base: string;
  readonly prompt: string;
  readonly rubric: string;
}
export interface PilotResult {
  readonly task: PilotTask;
  readonly arm: "auto" | "baseline";
  readonly attempts: number;
  readonly answer: string;
  readonly passed: boolean | null;
  readonly blocked: boolean;
  readonly history: ReadonlyArray<AutoContextMessage>;
  readonly routes: ReadonlyArray<{ model: string; effort: string; fallback: string | null }>;
}

export const runPilot = Effect.fn("NativeAutoPilot.run")(function* <R>(input: {
  readonly tasks: ReadonlyArray<PilotTask>;
  readonly samples: number;
  readonly request: (body: unknown) => Effect.Effect<unknown, Error, R>;
  readonly assertSettled: () => Effect.Effect<void, Error, R>;
  readonly prepare: (task: PilotTask, arm: string, sample: number) => Effect.Effect<void, Error, R>;
  readonly turn: (
    prompt: string,
    selection: ModelSelection,
    resume: boolean,
  ) => Effect.Effect<string, Error, R>;
  readonly check: (
    task: PilotTask,
  ) => Effect.Effect<{ passed: boolean | null; feedback: string }, Error, R>;
  readonly approveReview: (answer: string) => Effect.Effect<boolean, Error, R>;
  readonly save: (result: PilotResult, sample: number) => Effect.Effect<void, Error, R>;
}) {
  const context = yield* Effect.context<R>();
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "t3-auto" };
  for (let sample = 0; sample < input.samples; sample++) {
    for (const arm of sample % 2 === 0
      ? (["auto", "baseline"] as const)
      : (["baseline", "auto"] as const)) {
      let history: AutoContextMessage[] = [];
      let reviewApproved = false;
      for (const task of input.tasks) {
        const followup = task.id === "05-followup";
        if (followup && !reviewApproved) {
          yield* input.save(
            {
              task,
              arm,
              attempts: 0,
              answer: "",
              passed: null,
              blocked: true,
              history,
              routes: [],
            },
            sample,
          );
          continue;
        }
        if (!followup) {
          history = [];
        }
        yield* input.prepare(task, arm, sample);
        const prior = [...history];
        let prompt = task.prompt;
        let answer = "";
        let passed: boolean | null = null;
        let attempts = 0;
        const routes: { model: string; effort: string; fallback: string | null }[] = [];
        for (let attempt = 0; attempt < (task.id === "04-review" ? 1 : 2); attempt++) {
          history.push({ role: "user", text: prompt, attachmentCount: 0 });
          const route =
            arm === "auto"
              ? yield* classifyAuto({
                  selection,
                  messages: history,
                  request: (body) => input.request(body).pipe(Effect.provide(context)),
                })
              : { selection: autoSelection(selection, "baseline"), fallback: null };
          // The classifier catches timeouts; a held reservation still forbids provider startup.
          yield* input.assertSettled();
          const effort = route.selection.options?.find(
            (option) => option.id === "reasoningEffort",
          )?.value;
          routes.push({
            model: route.selection.model,
            effort: String(effort),
            fallback: route.fallback,
          });
          answer = yield* input.turn(
            `Pilot case: ${task.id}\n${prompt}`,
            route.selection,
            followup || attempt > 0,
          );
          yield* input.assertSettled();
          attempts++;
          history.push({ role: "assistant", text: answer, attachmentCount: 0 });
          const check = yield* input.check(task);
          passed = check.passed;
          if (passed !== false) break;
          prompt = `The fixed task checks failed:\n${check.feedback}\nCorrect the failure within the original task scope.`;
        }
        if (task.id === "04-review") {
          reviewApproved = passed !== false && (yield* input.approveReview(answer));
        }
        yield* input.save(
          { task, arm, attempts, answer, passed, blocked: false, history: prior, routes },
          sample,
        );
      }
    }
  }
});
