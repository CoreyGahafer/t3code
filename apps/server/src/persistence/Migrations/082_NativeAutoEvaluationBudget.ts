import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS native_auto_evaluation_reservations (
    request_id TEXT PRIMARY KEY,
    pricing_revision TEXT NOT NULL,
    maximum_microusd INTEGER NOT NULL CHECK(maximum_microusd > 0),
    actual_microusd INTEGER CHECK(actual_microusd >= 0)
  )`;
});
