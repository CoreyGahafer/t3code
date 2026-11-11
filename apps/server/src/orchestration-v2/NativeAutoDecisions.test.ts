import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeNativeAutoDecisions } from "./NativeAutoDecisions.ts";

const selection = { instanceId: ProviderInstanceId.make("isolated"), model: "t3-auto" };
const messages = [{ role: "user" as const, text: "private task", attachmentCount: 0 }];
it.live("saved opt-in uses the selected home key and writes only expiring metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const logs = path.join(home, "logs");
    yield* fs.makeDirectory(logs);
    yield* fs.writeFileString(path.join(logs, "1-old.json"), "{}");
    yield* fs.writeFileString(
      path.join(home, "auth.json"),
      '{"auth_mode":"apikey","OPENAI_API_KEY":"instance-only-key"}',
    );
    let calls = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;
        assert.equal(request.url, "https://api.openai.com/v1/decisions");
        assert.equal(request.headers.authorization, "Bearer instance-only-key");
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            answers: [{ type: "choice", name: "route", choice: "mechanical" }],
          }),
        );
      }),
    );
    const resolve = yield* makeNativeAutoDecisions({
      settings: yield* decodeSettings({
        nativeAutoEnabled: true,
        nativeAutoApproved: true,
      }),
      environment: {},
      home,
      logDirectory: logs,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    const routed = yield* resolve({ decisionId: "run:1", selection, messages });
    assert.equal(routed.model, "gpt-6.1-sol");
    assert.equal(calls, 1);
    const files = yield* fs.readDirectory(logs);
    assert.equal(files.length, 1);
    const metadata = yield* fs.readFileString(path.join(logs, files[0]!));
    assert.notInclude(metadata, "private task");
    assert.notInclude(metadata, "instance-only-key");
    assert.include(metadata, "native-auto-v1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.live("default-off and credential mismatch never call the transport", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(home, "auth.json"),
      '{"auth_mode":"apikey","OPENAI_API_KEY":"home-key"}',
    );
    for (const enabled of [false, true]) {
      const resolve = yield* makeNativeAutoDecisions({
        settings: yield* decodeSettings({
          nativeAutoEnabled: enabled,
          nativeAutoApproved: enabled,
        }),
        environment: { OPENAI_API_KEY: "different-key" },
        home,
        logDirectory: path.join(home, "logs"),
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not spend")),
        ),
      );
      const failure = yield* resolve({ decisionId: "never", selection, messages }).pipe(
        Effect.flip,
      );
      assert.equal(failure._tag, "NativeAutoUnavailable");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const decodeSettings = Schema.decodeEffect(CodexSettings);
