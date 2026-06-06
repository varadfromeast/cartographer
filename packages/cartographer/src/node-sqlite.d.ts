declare module "node:sqlite" {
  export class StatementSync {
    all(...anonymousParameters: unknown[]): Array<Record<string, unknown>>;
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined;
    run(...anonymousParameters: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
