import type { Db, Sql } from '../db.ts';
import type { Database, Session, Statement } from './contracts.ts';

// Reuses AIHOT's existing connection pool; no new driver, connection or ORM.
function session(client: Db): Session {
  return {
    async query<Row extends Record<string, unknown>>(statement: Statement): Promise<Row[]> {
      // postgres.js unsafe accepts a SQL string plus bound parameters. No user value is
      // interpolated into the SQL string by this module. Only fixed statements reach here.
      const rows = await client.unsafe<Row[]>(statement.text, statement.values);
      return Array.from(rows);
    },
  };
}
export function researchDatabase(client: Sql): Database {
  return {
    ...session(client),
    transaction<T>(work: (tx: Session) => Promise<T>): Promise<T> {
      return client.begin(tx => work(session(tx))) as Promise<T>;
    },
  };
}
