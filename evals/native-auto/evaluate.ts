import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  autoSelection,
  classifyAuto,
  type AutoContextMessage,
} from "../../apps/server/src/orchestration-v2/NativeAutoRouting.ts";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Positive = Count.check(Schema.isGreaterThan(0));
const Price = Schema.Struct({
  inputMicroUsdPerMillion: Positive,
  outputMicroUsdPerMillion: Count,
  maximumInputTokens: Positive,
  maximumOutputTokens: Positive,
});
export const Pricing = Schema.Struct({
  revision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  models: Schema.Struct({
    "gpt-6-luna": Price,
    "gpt-6.1-sol": Price,
    "gpt-6-astra": Price,
  }),
});
const Usage = Schema.Struct({ input_tokens: Count, output_tokens: Count });
export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  stage: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Evaluation failed at ${this.stage}; inspect the report and retained reservations.`;
  }
}

export const Answer = Schema.Struct({ answer: Schema.String, sourceCode: Schema.String });
const Response = Schema.Struct({
  status: Schema.Literals(["completed", "incomplete", "failed"]),
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeUsage = Schema.decodeUnknownEffect(Schema.Struct({ usage: Usage }));
const decodeResponse = Schema.decodeUnknownEffect(Response);
const decodeAnswer = Schema.decodeEffect(Schema.fromJsonString(Answer));

export interface EvaluationCase {
  readonly id: string;
  readonly source: string;
  readonly prompt: string;
  readonly rubric: string;
  readonly history?: ReadonlyArray<AutoContextMessage>;
  readonly sourceCode?: string;
  readonly testCode?: string;
}
export function tokenCost(usage: typeof Usage.Type, price: typeof Price.Type) {
  const cost =
    (BigInt(usage.input_tokens) * BigInt(price.inputMicroUsdPerMillion) +
      BigInt(usage.output_tokens) * BigInt(price.outputMicroUsdPerMillion) +
      999999n) /
    1000000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvaluationError({ stage: "cost-overflow" });
  return Number(cost);
}

export const evaluate = Effect.fn("NativeAutoEvaluation.evaluate")(function* (input: {
  readonly runId: string;
  readonly cases: ReadonlyArray<EvaluationCase>;
  readonly samples: number;
  readonly pricing: typeof Pricing.Type;
  readonly maximumOutputTokens: number;
  readonly request: (
    endpoint: "decisions" | "responses",
    body: unknown,
  ) => Effect.Effect<unknown, EvaluationError>;
  readonly verify: (
    fixture: EvaluationCase,
    sourceCode: string,
  ) => Effect.Effect<boolean, EvaluationError>;
  readonly save: (row: EvaluationRow) => Effect.Effect<void, EvaluationError>;
}) {
  const budget = yield* Budget.NativeAutoEvaluationBudget;
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "t3-auto" };
  const rows: EvaluationRow[] = [];
  for (const fixture of input.cases) {
    const messages = [
      ...(fixture.history ?? []),
      {
        role: "user" as const,
        text:
          fixture.prompt +
          (fixture.sourceCode === undefined ? "" : `\nsource.mjs:\n${fixture.sourceCode}`),
        attachmentCount: 0,
      },
    ];
    for (let sample = 0; sample < input.samples; sample++) {
      // Alternate execution order so the fixed baseline does not always get the warm cache.
      for (const arm of sample % 2 === 0
        ? (["auto", "baseline"] as const)
        : (["baseline", "auto"] as const)) {
        const started = yield* Clock.currentTimeMillis;
        let costMicroUsd = 0;
        let ambiguous = false;
        let pending = false;
        let inputTokens = 0;
        let outputTokens = 0;
        const meteredRequest = Effect.fn("NativeAutoEvaluation.request")(
          function* (
            endpoint: "decisions" | "responses",
            body: unknown,
            model: keyof typeof input.pricing.models,
          ) {
            const price = input.pricing.models[model];
            const maximumMicroUsd = tokenCost(
              {
                input_tokens: price.maximumInputTokens,
                output_tokens:
                  endpoint === "responses" ? input.maximumOutputTokens : price.maximumOutputTokens,
              },
              price,
            );
            const requestId = `${input.runId}:${fixture.id}:${sample}:${arm}:${endpoint}`;
            if (
              !(yield* budget.reserve({
                approved: true,
                requestId,
                pricingRevision: input.pricing.revision,
                maximumMicroUsd,
              }))
            ) {
              return yield* new EvaluationError({ stage: "reservation" });
            }
            pending = true;
            const raw = yield* input.request(endpoint, body);
            const usage = yield* decodeUsage(raw).pipe(
              Effect.mapError(() => new EvaluationError({ stage: "usage" })),
            );
            const actualMicroUsd = tokenCost(usage.usage, price);
            yield* budget.reconcile({ requestId, actualMicroUsd });
            pending = false;
            inputTokens += usage.usage.input_tokens;
            outputTokens += usage.usage.output_tokens;
            costMicroUsd += actualMicroUsd;
            if (
              actualMicroUsd > maximumMicroUsd ||
              usage.usage.input_tokens > price.maximumInputTokens ||
              usage.usage.output_tokens >
                (endpoint === "responses" ? input.maximumOutputTokens : price.maximumOutputTokens)
            ) {
              return yield* new EvaluationError({ stage: "pricing-bounds" });
            }
            return raw;
          },
          Effect.tapError(() =>
            Effect.sync(() => {
              ambiguous = true;
            }),
          ),
        );
        let route = autoSelection(selection, "baseline");
        let fallback: string | null = null;
        let policy = "fixed-baseline";
        if (arm === "auto") {
          const classified = yield* classifyAuto({
            selection,
            messages,
            request: (body) =>
              meteredRequest("decisions", body, "gpt-6-luna").pipe(
                Effect.mapError(() => new EvaluationError({ stage: "classification" })),
              ),
          });
          route = classified.selection;
          fallback = classified.fallback;
          policy = classified.policy;
          // A timeout may occur after dispatch; its reservation remains spent and no further calls follow.
          if (fallback === "classification-failed" && pending) ambiguous = true;
        }
        const effort = route.options?.find((option) => option.id === "reasoningEffort")?.value;
        let answer = { answer: "", sourceCode: "" };
        let passed: boolean | null = null;
        let status: "completed" | "failed" = "failed";
        if (!ambiguous) {
          const attempt = yield* Effect.gen(function* () {
            const raw = yield* meteredRequest(
              "responses",
              {
                model: route.model,
                reasoning: { effort },
                input: messages.map((message) => ({ role: message.role, content: message.text })),
                max_output_tokens: input.maximumOutputTokens,
                store: false,
                text: {
                  format: {
                    type: "json_schema",
                    name: "evaluation_answer",
                    strict: true,
                    schema: {
                      type: "object",
                      properties: { answer: { type: "string" }, sourceCode: { type: "string" } },
                      required: ["answer", "sourceCode"],
                      additionalProperties: false,
                    },
                  },
                },
              },
              route.model === "gpt-6.1-sol" ? "gpt-6.1-sol" : "gpt-6-astra",
            );
            const response = yield* decodeResponse(raw);
            if (response.status !== "completed")
              return yield* new EvaluationError({ stage: "incomplete-response" });
            const text = response.output
              .filter((item) => item.type === "message")
              .flatMap((item) => item.content ?? [])
              .filter((part) => part.type === "output_text")
              .map((part) => part.text ?? "")
              .join("");
            answer = yield* decodeAnswer(text);
            passed =
              fixture.sourceCode === undefined
                ? null
                : yield* input.verify(fixture, answer.sourceCode);
            status = "completed";
          }).pipe(Effect.result);
          if (attempt._tag === "Failure") status = "failed";
        }
        const row: EvaluationRow = {
          id: fixture.id,
          sample,
          arm,
          model: route.model,
          effort,
          policy,
          fallback,
          latencyMs: (yield* Clock.currentTimeMillis) - started,
          costMicroUsd: ambiguous ? null : costMicroUsd,
          usage: ambiguous ? null : { inputTokens, outputTokens },
          status,
          passed,
          ...answer,
        };
        rows.push(row);
        yield* input.save(row);
        if (ambiguous) return yield* new EvaluationError({ stage: "ambiguous-request" });
      }
    }
  }
  return rows;
});
export interface EvaluationRow {
  readonly id: string;
  readonly sample: number;
  readonly arm: "auto" | "baseline";
  readonly model: string;
  readonly effort: string | boolean | undefined;
  readonly policy: string;
  readonly fallback: string | null;
  readonly latencyMs: number;
  readonly costMicroUsd: number | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly status: "completed" | "failed";
  readonly passed: boolean | null;
  readonly answer: string;
  readonly sourceCode: string;
}
