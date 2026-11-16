#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import createBudgetTable from "../../apps/server/src/persistence/Migrations/082_NativeAutoEvaluationBudget.ts";
import * as Budget from "../../apps/server/src/orchestration-v2/NativeAutoEvaluationBudget.ts";
import { Pricing } from "./evaluate.ts";
import { guard, initializeGuard } from "./guard.ts";

const Config = Schema.Struct({ database: Schema.String, origin: Schema.String, pricing: Pricing });
try {
  const configPath = process.argv[2];
  if (!configPath || !NodePath.isAbsolute(configPath)) throw new Error("Absolute config required");
  const stat = await NodeFSP.stat(configPath);
  if ((stat.mode & 0o077) !== 0) throw new Error("Private config required");
  const config = Schema.decodeUnknownSync(Config)(
    JSON.parse(await NodeFSP.readFile(configPath, "utf8")),
  );
  if (!NodePath.isAbsolute(config.database)) throw new Error("Absolute ledger required");
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 65536) throw new Error("Oversized guard input");
  }
  const database = NodeSqliteClient.layer({ filename: config.database });
  const layer = Budget.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(createBudgetTable).pipe(Layer.provideMerge(database))),
  );
  const input: unknown = JSON.parse(body);
  const ack = await Effect.runPromise(
    Effect.gen(function* () {
      yield* initializeGuard;
      return yield* guard(config, input);
    }).pipe(Effect.provide(layer)),
  );
  process.stdout.write(JSON.stringify(ack) + "\n");
} catch {
  process.stderr.write("Budget guard refused request; inspect retained ledger reservations.\n");
  process.exitCode = 1;
}
