/**
 * The app's database. Everything server-side imports from here.
 *
 * Which host provides it is decided at build time by the `#host/db` import
 * (package.json `imports`): Bun + a SQLite file by default, Cloudflare D1 on
 * Workers. See `db/host/types.ts` for the contract, and
 * `plans/hosting-other-camps.md` for why.
 */
import * as schema from "./schema";

export { atomic, db, dbSnapshot } from "#host/db";
export type { AtomicStatement, Db } from "./host/types";
export { schema };
