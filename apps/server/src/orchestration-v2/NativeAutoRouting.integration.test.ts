import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { autoSelection } from "./NativeAutoRouting.ts";

const instanceId = ProviderInstanceId.make("codex");
it.effect("persists a concrete route before provider startup and retains saved Auto intent", () => {
  let classifications = 0;
  const database = SqlitePersistence.layerMemory;
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      resolveAutoModel: (input) =>
        Effect.sync(() => {
          classifications++;
          assert.equal(input.messages.at(-1)?.text, "rename the constant");
          if (classifications === 2)
            assert.isTrue(
              input.messages.some(
                (message) => message.role === "assistant" && message.text === "The parser plan",
              ),
            );
          return autoSelection(input.selection, "mechanical");
        }),
      openSession: () => Effect.die("Provider must not start before the committed outbox"),
    },
  ]);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:auto");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-auto"),
      threadId,
      projectId: ProjectId.make("project:auto"),
      title: "Auto",
      modelSelection: { instanceId, model: "t3-auto" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("message-auto"),
      threadId,
      messageId: MessageId.make("message:auto"),
      text: "rename the constant",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("message-auto"),
      threadId,
      messageId: MessageId.make("message:auto"),
      text: "rename the constant",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* store.getThreadProjection(threadId);
    assert.equal(classifications, 1);
    assert.equal(projection.thread.modelSelection.model, "t3-auto");
    assert.equal(projection.runs[0]?.modelSelection.model, "gpt-6.1-sol");
    assert.isTrue(projection.runs[0]?.autoRoute);
    yield* store.apply({
      id: EventId.make("queue-auto"),
      type: "run.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: { ...projection.runs[0]!, status: "queued", startedAt: null, queueHeld: true },
    });
    yield* orchestrator.dispatch({
      type: "queued-run.start",
      commandId: CommandId.make("promote-auto"),
      threadId,
      runId: projection.runs[0]!.id,
    });
    const promoted = yield* store.getThreadProjection(threadId);
    assert.equal(classifications, 1);
    assert.deepEqual(promoted.runs[0]?.modelSelection, projection.runs[0]?.modelSelection);

    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("manual-pin"),
      threadId,
      modelSelection: { instanceId, model: "gpt-6-astra" },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("manual-message"),
      threadId,
      messageId: MessageId.make("message:manual"),
      text: "rename the constant",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal(classifications, 1);
    assert.equal(
      (yield* store.getThreadProjection(threadId)).runs.at(-1)?.modelSelection.model,
      "gpt-6-astra",
    );
    yield* store.apply({
      id: EventId.make("assistant-context"),
      type: "message.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...projection.messages[0]!,
        id: MessageId.make("assistant-context"),
        role: "assistant",
        text: "The parser plan",
      },
    });
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("restore-auto"),
      threadId,
      modelSelection: { instanceId, model: "t3-auto" },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restored-message"),
      threadId,
      messageId: MessageId.make("message:restored"),
      text: "rename the constant",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal(classifications, 2);
    const restored = yield* store.getThreadProjection(threadId);
    assert.equal(restored.thread.modelSelection.model, "t3-auto");
    assert.equal(restored.runs.at(-1)?.modelSelection.model, "gpt-6.1-sol");
    assert.isTrue(restored.runs.at(-1)?.autoRoute);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent"),
      threadId: ThreadId.make("parent"),
      projectId: ProjectId.make("project:auto"),
      title: "Parent",
      modelSelection: { instanceId, model: "gpt-6-astra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* store.apply({
      id: EventId.make("mark-child"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...restored.thread,
        lineage: {
          ...restored.thread.lineage,
          relationshipToParent: "subagent",
          parentThreadId: ThreadId.make("parent"),
        },
      },
    });
    yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("child-auto"),
        threadId,
        messageId: MessageId.make("child-auto"),
        text: "rename the constant",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(classifications, 2);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("child-concrete"),
      threadId,
      messageId: MessageId.make("child-concrete"),
      text: "rename the constant",
      attachments: [],
      modelSelection: { instanceId, model: "gpt-6-astra" },
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal(classifications, 2);
    assert.equal(
      (yield* store.getThreadProjection(threadId)).runs.at(-1)?.modelSelection.model,
      "gpt-6-astra",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry({ name: "native-auto" }, registry, {
          databaseLayer: database,
          runEffectWorker: false,
        }),
      ),
    ),
  );
});

it.effect(
  "reopens durable Auto routes for queue promotion and restart continuation without classification",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-auto-restart-" });
      const threadId = ThreadId.make("thread:auto-restart");
      let classifications = 0;
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          resolveAutoModel: (input) =>
            Effect.sync(() => {
              classifications++;
              return autoSelection(input.selection, "mechanical");
            }),
          openSession: () => Effect.die("No provider work during admission proof"),
        },
      ]);
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const runtime = Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry({ name: "native-auto-restart" }, registry, {
          databaseLayer: database,
          runEffectWorker: false,
        }),
      );
      const saved = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("restart-create"),
          threadId,
          projectId: ProjectId.make("project:auto-restart"),
          title: "Auto restart",
          modelSelection: { instanceId, model: "t3-auto" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart-message"),
          threadId,
          messageId: MessageId.make("restart-message"),
          text: "Rename the constant",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
        yield* store.apply({
          id: EventId.make("restart-queue"),
          type: "run.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, status: "queued", startedAt: null, queueHeld: true },
        });
        return run;
      }).pipe(Effect.provide(runtime));
      assert.equal(classifications, 1);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const reopened = yield* store.getThreadProjection(threadId);
        assert.equal(reopened.thread.modelSelection.model, "t3-auto");
        assert.deepEqual(reopened.runs[0]?.modelSelection, saved.modelSelection);
        assert.isTrue(reopened.runs[0]?.autoRoute);
        yield* orchestrator.dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("restart-promote"),
          threadId,
          runId: saved.id,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart-continue"),
          threadId,
          messageId: MessageId.make("restart-continue"),
          text: "Continue after restart",
          attachments: [],
          restartContinuationOfRunId: saved.id,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        });
        const continued = yield* store.getThreadProjection(threadId);
        assert.deepEqual(continued.runs.at(-1)?.modelSelection, saved.modelSelection);
        assert.isTrue(continued.runs.at(-1)?.autoRoute);
        assert.equal(classifications, 1);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
