/**
 * The contract every database host implements (plans/hosting-other-camps.md).
 *
 * CampTool runs on more than one host: Bun + a SQLite file (firefly, jackson,
 * any Docker box) and Cloudflare Workers + D1. Each host module lives next to
 * this file and is picked at build time through the `#host/db` import in
 * package.json (`workerd` condition on Cloudflare, `default` elsewhere), so a
 * bundle only ever carries its own host's code.
 *
 * App code imports `db` and friends from `db/client.server.ts`, never from a
 * host module directly.
 */
import type { SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../schema";

/**
 * The Drizzle database, typed as the **async** flavor on every host. Bun's
 * SQLite driver is synchronous underneath, but code written against the sync
 * result types (`.all()` without `await`) would break on D1, so the type
 * doesn't offer them. `await` works on both.
 *
 * `transaction` is left out on purpose: D1 has no interactive transactions.
 * Use `atomic` for writes that must land together.
 */
export type Db = Omit<
  BaseSQLiteDatabase<"async", unknown, typeof schema>,
  "transaction"
>;

/**
 * One write inside `atomic`: a Drizzle insert/update/delete builder, or raw
 * `sql`. Built but not yet run.
 */
export type AtomicStatement =
  | SQL
  | { run: () => unknown; toSQL: () => { sql: string; params: unknown[] } };

/** A whole-database backup, in the form this host can produce. */
export type DbSnapshot = {
  /** File name inside the backup archive. */
  name: string;
  bytes: Uint8Array;
};
