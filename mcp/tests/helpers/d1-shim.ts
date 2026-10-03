import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 測試用的 D1 替身：以 node:sqlite 實作 D1 的 prepare/bind/first/all/run/batch，
 * 讓 migration 與所有 SQL 在真正的 SQLite 上執行。batch 與 D1 一樣是交易。
 * failOn 可以讓符合條件的 SQL 丟錯，用來測交易回復（T-006）。
 */
export class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  failOn: ((sql: string) => boolean) | null = null;

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const dir = join(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(dir, file), "utf8"));
    }
  }

  prepare(sql: string) {
    return new TestStatement(this, sql, []);
  }

  async batch(statements: TestStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const stmt of statements) out.push(stmt.runSync());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  count(table: string): number {
    return (this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  rows<T>(sql: string): T[] {
    return this.sqlite.prepare(sql).all() as T[];
  }
}

class TestStatement {
  constructor(
    private readonly db: TestD1,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...params: unknown[]) {
    return new TestStatement(this.db, this.sql, params);
  }

  private args() {
    return this.params.map((p) => (p === undefined ? null : p)) as (string | number | null)[];
  }

  private check() {
    if (this.db.failOn?.(this.sql)) throw new Error("injected failure");
  }

  runSync() {
    this.check();
    const info = this.db.sqlite.prepare(this.sql).run(...this.args());
    return { success: true, meta: { changes: Number(info.changes) }, results: [] };
  }

  async run() {
    return this.runSync();
  }

  async first<T>() {
    this.check();
    return (this.db.sqlite.prepare(this.sql).get(...this.args()) ?? null) as T | null;
  }

  async all<T>() {
    this.check();
    return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args()) as T[], meta: {} };
  }
}
