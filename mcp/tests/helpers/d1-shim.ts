import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

/**
 * 測試用的 D1 替身：以 node:sqlite 實作 D1 的 prepare/bind/first/all/run/batch，
 * 讓 migration 與所有 SQL 在真正的 SQLite 上執行。batch 與 D1 一樣是交易。
 * failOn 可以讓符合條件的 SQL 丟錯，用來測交易回復（T-006）。
 */
export class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  failOn: ((sql: string) => boolean) | null = null;

  /** upTo：只套用到這個 migration（含），用來測後面的 migration 如何轉換舊資料。 */
  constructor(upTo?: string) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of TestD1.migrations()) {
      this.migrate(file);
      if (file === upTo) break;
    }
  }

  static migrations(): string[] {
    return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  }

  migrate(file: string): void {
    this.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
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
    // 與 Cloudflare D1 相同：一個查詢最多 100 個 bind 參數。
    if (params.length > 100) throw new Error(`too many SQL variables: ${params.length}`);
    return new TestStatement(this.db, this.sql, params);
  }

  private args() {
    return this.params.map((p) => (p === undefined ? null : p)) as (string | number | null)[];
  }

  private check() {
    if (this.db.failOn?.(this.sql)) throw new Error("injected failure");
    // 模擬 D1：LIKE／GLOB 樣式上限約 50 bytes（node:sqlite 預設 50000，不會擋）。
    if (/\b(LIKE|GLOB)\b/i.test(this.sql)) {
      for (const p of this.params) {
        if (typeof p === "string" && Buffer.byteLength(p) > 50) throw new Error("LIKE or GLOB pattern too complex: SQLITE_ERROR");
      }
    }
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
