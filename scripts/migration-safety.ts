// A deliberately small online-migration vocabulary. Unknown SQL needs an explicit safety design, not an opt-out.
export const FIRST_ONLINE_MIGRATION = 55;
export type MigrationPlan = { kind: "transaction" | "validation" | "statistics" } | { kind: "index"; index: string; table: string };

// Keep quoted values opaque, including their semicolons and comment markers. SQL bodies are not in
// the accepted vocabulary; rejecting them also prevents hiding writes in DO or function definitions.
function statements(text: string): string[][] {
  const result: string[][] = [];
  let tokens: string[] = [];
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { i += whitespace[0].length; continue; }
    if (rest.startsWith("--")) { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (depth && i < text.length) {
        if (text.startsWith("/*", i)) { depth++; i += 2; }
        else if (text.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("unterminated SQL comment");
      continue;
    }
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i++] !== quote) continue;
        if (text[i] === quote) { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) throw new Error("unterminated SQL quote");
      tokens.push(text.slice(start, i));
      continue;
    }
    if (/^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(rest)) throw new Error("SQL bodies are not online migrations");
    if (quote === ";") { if (tokens.length) result.push(tokens); tokens = []; i++; continue; }
    // Keep compound operators intact, stopping before comments. PostgreSQL separates a trailing
    // +/- from ordinary operators (<=-1, ->-1), except in names containing a special operator char.
    let operator = /^(?:(?!--|\/\*)[+\-*/<>=~!@#%^&|`?])+/.exec(rest)?.[0];
    if (operator && !/[~!@#%^&|`?]/.test(operator)) operator = operator.replace(/[+-]+$/, "") || operator[0];
    const token = /^[a-z_][a-z0-9_$]*|^-?\d+(?:\.\d+)?|^::/i.exec(rest)?.[0] ?? operator ?? quote;
    tokens.push(token);
    i += token.length;
  }
  if (tokens.length) result.push(tokens);
  return result;
}

const IDENT = '(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")';
const RELATION = `${IDENT}(?: \\. ${IDENT})?`;
const TYPE = '(?:text|boolean|smallint|int|integer|bigint|real|double precision|numeric(?: \\( \\d+(?: , \\d+)? \\))?|timestamp(?: \\( \\d+ \\))?(?: with(?:out)? time zone)?|timestamptz|date|uuid|jsonb?|bytea)(?: \\[ \\])*';
const LITERAL = `(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|true|false|null)(?: :: ${TYPE})?`;
const addColumn = new RegExp(`^alter table ${RELATION} add column (?:if not exists )?${IDENT} ${TYPE}(?: not null)?(?: default ${LITERAL})?(?: not null)?$`, "i");
const alterDefault = new RegExp(`^alter table ${RELATION} alter column ${IDENT} (?:set default ${LITERAL}|drop default)$`, "i");
const indexStart = new RegExp(`^create (unique )?index concurrently if not exists (${IDENT}) on (${RELATION}) `, "i");

/** Let PostgreSQL normalize the intended index on an empty temporary copy, without reading table data. */
export function indexOnEmptyTable(text: string): string {
  const sql = statements(text)[0].join(" ");
  return sql.replace(indexStart, (_match, unique: string | undefined) => `CREATE ${unique ?? ""}INDEX migration_expected_index ON pg_temp.migration_expected_table `);
}

function singleAction(tokens: string[]) {
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (token === "," && depth === 0) return false;
  }
  return depth === 0;
}

export function migrationPlan(text: string): MigrationPlan {
  const all = statements(text);
  if (all.length !== 1) throw new Error("use one statement per online migration so strong table locks cannot accumulate");
  const tokens = all[0];
  const sql = tokens.join(" ");
  const words = tokens.filter((token) => /^[a-z_]/i.test(token)).join(" ");
  if (/^create (?:unique )?index\b/i.test(sql)) {
    const match = indexStart.exec(sql);
    if (!match) throw new Error("indexes require CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    return { kind: "index", index: match[2], table: match[3].replace(/ \. /g, ".") };
  }
  if (new RegExp(`^alter table ${RELATION} validate constraint ${IDENT}$`, "i").test(sql)) return { kind: "validation" };
  // These take SHARE UPDATE EXCLUSIVE, which permits ordinary reads and writes. Keep ANALYZE
  // scoped to named columns of one table; SKIP_LOCKED could silently leave its statistics unbuilt.
  if (new RegExp(`^create statistics ${RELATION} \\( mcv \\) on ${IDENT}(?: , ${IDENT}){1,7} from ${RELATION}$`, "i").test(sql)
    || new RegExp(`^analyze ${RELATION} \\( ${IDENT}(?: , ${IDENT})* \\)$`, "i").test(sql)) return { kind: "statistics" };
  if (new RegExp(`^create table (?:if not exists )?${RELATION} \\(.*\\)$`, "i").test(sql)
    && !/\b(as|like|inherits|partition)\b/i.test(words)) return { kind: "transaction" };
  if (!singleAction(tokens)) throw new Error("use one ALTER TABLE action per statement");
  if (addColumn.test(sql)) {
    if (/\bnot null\b/i.test(words) && (!/\bdefault\b/i.test(words) || /\bdefault null\b/i.test(words))) throw new Error("NOT NULL on a new column requires a non-null constant default");
    return { kind: "transaction" };
  }
  if (alterDefault.test(sql)) return { kind: "transaction" };
  if (new RegExp(`^alter table ${RELATION} add constraint ${IDENT} (?:check \\(.*\\)|foreign key \\(.*\\) references .*) not valid$`, "i").test(sql)) return { kind: "transaction" };
  throw new Error(`not safe for an online migration: ${sql.slice(0, 180)}. Use constant-default columns, NOT VALID then separate validation, concurrent indexes, or column MCV statistics with separate column ANALYZE; backfill data in bounded batches outside release migrations.`);
}
