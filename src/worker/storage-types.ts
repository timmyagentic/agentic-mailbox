export interface MailResult<T> {
  results: T[];
  meta: { changes: number };
}

export interface MailStatement {
  bind(...values: unknown[]): MailStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<MailResult<T>>;
  run<T = unknown>(): Promise<MailResult<T>>;
}

export interface MailDatabase {
  prepare(sql: string): MailStatement;
  batch<T = unknown>(statements: MailStatement[]): Promise<MailResult<T>[]>;
}

export interface MailBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptions): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}
