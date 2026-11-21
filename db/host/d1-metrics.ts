/**
 * Per-request D1 accounting, reported as a `Server-Timing` header by
 * `workers/app.ts` (plans/fast-navigation.md).
 *
 * On Workers every D1 query is a network round trip, so a page's speed is
 * mostly "how many queries, and how many of them ran one after another". This
 * counts queries, how many times the request had to wait for D1 (queries sent
 * together are one wait), and the time at least one was in flight. Waits ×
 * round-trip time is roughly what the page costs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types/index.ts";

export type DbMetrics = {
  /** Statements sent (a batch counts each statement, in one round trip). */
  queries: number;
  /** Times the request went from no query in flight to one: queries sent
   * together (`Promise.all`, a batch) count once. */
  waits: number;
  /** Time with at least one round trip in flight. */
  busyMs: number;
  inFlight: number;
  busySince: number;
};

const store = new AsyncLocalStorage<DbMetrics>();

/** Run `fn` with a fresh metrics record; returns both. */
export async function withDbMetrics<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; metrics: DbMetrics }> {
  const metrics: DbMetrics = {
    queries: 0,
    waits: 0,
    busyMs: 0,
    inFlight: 0,
    busySince: 0,
  };
  const result = await store.run(metrics, fn);
  return { result, metrics };
}

async function track<T>(statements: number, run: () => Promise<T>) {
  const m = store.getStore();
  if (!m) return run();
  m.queries += statements;
  if (m.inFlight++ === 0) {
    m.waits += 1;
    m.busySince = performance.now();
  }
  try {
    return await run();
  } finally {
    if (--m.inFlight === 0) m.busyMs += performance.now() - m.busySince;
  }
}

const RUNNERS = ["first", "all", "run", "raw"] as const;

/** Make `stmt` (and every statement `bind` derives from it) report to the
 * current request's metrics. Mutates in place so `batch()` still receives
 * D1's own statement objects. */
function instrumentStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  type Method = (...args: unknown[]) => unknown;
  const s = stmt as unknown as Record<
    (typeof RUNNERS)[number] | "bind",
    Method
  >;
  for (const name of RUNNERS) {
    const original = s[name].bind(stmt);
    s[name] = (...args) =>
      track(1, () => original(...args) as Promise<unknown>);
  }
  const bind = s.bind.bind(stmt);
  s.bind = (...args) =>
    instrumentStatement(bind(...args) as D1PreparedStatement);
  return stmt;
}

/** Wrap a D1 binding so its queries are counted per request. */
export function instrumentD1(d1: D1Database): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => instrumentStatement(target.prepare(query));
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) =>
          track(statements.length, () => target.batch(statements));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `Server-Timing` value for a finished request. */
export function serverTiming(
  metrics: DbMetrics,
  totalMs: number,
  colo?: string,
): string {
  return [
    `db;dur=${metrics.busyMs.toFixed(0)};desc="${metrics.queries} queries in ${metrics.waits} waits"`,
    `total;dur=${totalMs.toFixed(0)}`,
    // Where the Worker ran: with placement pinned, every visitor's request
    // should show the database's data center (app/lib/nav-timing.ts
    // records it).
    ...(colo && /^[A-Z]{3}$/.test(colo) ? [`colo;desc="${colo}"`] : []),
  ].join(", ");
}
