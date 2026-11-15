import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

class Statement {
  constructor(
    public owner: SqliteDatabase,
    public sql: string,
    public values: SQLInputValue[] = [],
  ) {}
  bind(...values: SQLInputValue[]) {
    return new Statement(this.owner, this.sql, values);
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values);
    return (row ? (column ? row[column] : { ...row }) : null) as T | null;
  }
  async all<T>() {
    const rows = this.owner.sqlite
      .prepare(this.sql)
      .all(...this.values)
      .map((r) => ({ ...r }));
    return { success: true, results: rows as T[], meta: { changes: 0 } };
  }
  execute() {
    const result = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
  async run() {
    return this.execute();
  }
}
/** Implements the D1 methods used by the shared application, backed by real SQLite. */
export class SqliteDatabase {
  sqlite: DatabaseSync;
  constructor(filename: string, migrations: string) {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
    );
    for (const name of fs
      .readdirSync(migrations)
      .filter((n) => /^\d+_[a-z0-9_-]+\.sql$/.test(n))
      .sort()) {
      const sql = fs.readFileSync(path.join(migrations, name), 'utf8').replaceAll('\r\n', '\n'),
        checksum = createHash('sha256').update(sql).digest('hex');
      const applied = this.sqlite
        .prepare('SELECT checksum FROM _migrations WHERE name=?')
        .get(name);
      if (applied) {
        if (applied.checksum !== checksum) throw Error('已应用的数据库迁移被修改：' + name);
        continue;
      }
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        this.sqlite.exec(sql);
        this.sqlite.prepare('INSERT INTO _migrations VALUES(?,?)').run(name, checksum);
        this.sqlite.exec('COMMIT');
      } catch (e) {
        this.sqlite.exec('ROLLBACK');
        throw e;
      }
    }
  }
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
  async batch(statements: Statement[]) {
    if (statements.some((s) => s.owner !== this)) throw Error('跨数据库批处理无效');
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  asD1() {
    return this as unknown as D1Database;
  }
  close() {
    this.sqlite.close();
  }
}
