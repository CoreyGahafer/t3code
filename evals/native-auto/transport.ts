import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { EvaluationError } from "./evaluate.ts";

export const requestPaid = Effect.fn("NativeAutoEvaluation.transport")(
  function* (key: string, endpoint: "decisions" | "responses", body: unknown) {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .pipe(HttpClient.filterStatusOk)
      .execute(
        HttpClientRequest.post(`https://api.openai.com/v1/${endpoint}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${key}`),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.flatMap((response) => response.json));
  },
  Effect.timeout("2 minutes"),
  Effect.scoped,
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(1)),
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError((cause) => new EvaluationError({ stage: "transport", cause })),
);
