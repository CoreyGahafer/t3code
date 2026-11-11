import type { CodexSettings, ModelSelection } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";
import {
  classifyAuto,
  NativeAutoUnavailable,
  type AutoContextMessage,
} from "./NativeAutoRouting.ts";

export const makeNativeAutoDecisions = Effect.fn("NativeAutoDecisions.make")(function* (input: {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly logDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const prune = Effect.fn("NativeAutoDecisions.prune")(function* () {
    if (!(yield* fs.exists(input.logDirectory))) return;
    const now = yield* Clock.currentTimeMillis;
    for (const entry of yield* fs.readDirectory(input.logDirectory)) {
      const timestamp = /^(\d+)-.*\.json$/u.exec(entry)?.[1];
      if (timestamp && Number(timestamp) < now - 30 * 86400000)
        yield* fs.remove(path.join(input.logDirectory, entry)).pipe(Effect.ignore);
    }
  });
  yield* prune().pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
  return Effect.fn("NativeAutoDecisions.resolve")(
    function* (request: {
      readonly decisionId: string;
      readonly selection: ModelSelection;
      readonly messages: ReadonlyArray<AutoContextMessage>;
    }) {
      if (!input.settings.nativeAutoEnabled || !input.settings.nativeAutoApproved)
        return yield* new NativeAutoUnavailable({ reason: "evaluation-required" });
      const unavailable = () => new NativeAutoUnavailable({ reason: "unsupported-auth" });
      if (
        input.settings.setupMode === "managed" ||
        input.settings.launchArgs.trim() ||
        input.environment.T3CODE_CODEX_LAUNCH_ARGS ||
        input.environment.OPENAI_BASE_URL
      )
        return yield* unavailable();
      const configPath = path.join(input.home, "config.toml");
      const config = (yield* fs.exists(configPath)) ? yield* fs.readFileString(configPath) : "";
      if (
        /model_provider|openai_base_url|api_key|auth_mode|cli_auth_credentials_store/u.test(config)
      )
        return yield* unavailable();
      const auth = yield* fs
        .readFileString(path.join(input.home, "auth.json"))
        .pipe(Effect.flatMap(SchemaAuth), Effect.mapError(unavailable));
      const key = auth.OPENAI_API_KEY;
      if (
        auth.auth_mode !== "apikey" ||
        !key ||
        (input.environment.OPENAI_API_KEY && input.environment.OPENAI_API_KEY !== key)
      )
        return yield* unavailable();
      const started = yield* Clock.currentTimeMillis;
      const result = yield* classifyAuto({
        ...request,
        request: (body) =>
          HttpClient.withScope(client)
            .execute(
              HttpClientRequest.post("https://api.openai.com/v1/decisions").pipe(
                HttpClientRequest.setHeader("authorization", `Bearer ${key}`),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            )
            .pipe(
              Effect.flatMap(
                Effect.fn("NativeAutoDecisions.decode")(function* (
                  response: import("effect/http/HttpClientResponse").HttpClientResponse,
                ) {
                  if (response.status !== 200) return yield* unavailable();
                  const text = yield* response.text;
                  if (text.length > 16384) return yield* unavailable();
                  return yield* decodeJson(text);
                }),
              ),
              Effect.mapError(() => unavailable()),
              Effect.scoped,
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              Effect.withTracerEnabled(false),
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(16384)),
            ),
      });
      const ended = yield* Clock.currentTimeMillis;
      yield* fs.makeDirectory(input.logDirectory, { recursive: true });
      yield* prune();
      yield* fs.writeFileString(
        path.join(input.logDirectory, `${ended}-${encodeURIComponent(request.decisionId)}.json`),
        yield* encodeJson({
          policy: result.policy,
          model: result.selection.model,
          effort: result.selection.options?.find((option) => option.id === "reasoningEffort")
            ?.value,
          latencyMs: ended - started,
          fallback: result.fallback,
          usage: result.usage,
          cost: null,
        }),
      );
      return result.selection;
    },
    Effect.mapError((cause) =>
      isNativeAutoUnavailable(cause)
        ? cause
        : new NativeAutoUnavailable({ reason: "unsupported-auth" }),
    ),
  );
});
const SchemaAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.String,
      OPENAI_API_KEY: Schema.String,
    }),
  ),
);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const isNativeAutoUnavailable = Schema.is(NativeAutoUnavailable);
