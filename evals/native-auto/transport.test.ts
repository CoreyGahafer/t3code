import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { requestPaid } from "./transport.ts";

it.effect(
  "uses only the direct OpenAI endpoint, sends bounded request settings, and refuses redirects without retry",
  () =>
    Effect.gen(function* () {
      for (const status of [200, 302, 401]) {
        let calls = 0;
        const result = yield* requestPaid("fixture-key", "responses", {
          model: "fixture",
          max_output_tokens: 100,
          store: false,
        }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
            calls++;
            const request = new Request(url, init);
            assert.equal(request.url, "https://api.openai.com/v1/responses");
            assert.equal(request.method, "POST");
            assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
            assert.equal(init?.redirect, "manual");
            assert.deepEqual(await request.json(), {
              model: "fixture",
              max_output_tokens: 100,
              store: false,
            });
            return new Response('{"usage":{"input_tokens":1,"output_tokens":2}}', { status });
          }),
          Effect.result,
        );
        assert.equal(calls, 1);
        assert.equal(result._tag, status === 200 ? "Success" : "Failure");
      }
    }),
);
