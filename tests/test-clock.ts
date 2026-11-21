import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, type Violation } from "./source-checks.ts";

const root = path.resolve(import.meta.dirname, "..");
const boundary = "按编号区分先后，或给测试数据明确的过去时间；写入与读取边界不要分两次取此刻";
const wait = "等待可观察的状态、事件或可控计时器；不要用休眠判定操作完成";
const id = "编号使用 randomUUID()、测试序号或 tag()，不要只用系统时钟";
const clock = String.raw`(?:new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))`;
const fields = "publishedAt|discoveredAt|releasedAt|visibleAfter|startAfter|nextCheckAt|observedAt|\\w*(?:Since|Before|After)";
const sqlFields = "published_at|discovered_at|visible_after|start_after|next_check_at|observed_at|sort_at";
const current = String.raw`(?:now\s*\(\s*\)|current_timestamp|clock_timestamp\s*\(\s*\))`;
const sqlClock = String.raw`(?:${current}|\$\{\s*${clock}\s*\})`;
const value = new RegExp(String.raw`\b(?:${fields})\s*:\s*${clock}(?!\s*[+-]|\.getTime\(\)\s*[+-])`, "g");
const due = new RegExp(String.raw`\b(?:${sqlFields})\s*=\s*${sqlClock}(?!\s*[+-])`, "gi");
const sleeps = /\b(?:waitForTimeout|sleep|delay)\s*\(\s*(?:\d|[\w$]+\s*\))|(?<!test\.)\bsetTimeout\s*\(\s*(?:\d|(?:resolve|res|r|done)\s*,|\(\s*\)\s*=>\s*(?:resolve|res|r|done)\(\s*\)\s*,)|\btime\.sleep\s*\(/g;
const numberId = /\b(?:\w*[Ii]d|ID|key|tag)\s*[:=]\s*(?:String\()?Date\.now\(\)(?!\s*[-+/])|`[^`\n]*\$\{Date\.now\(\)(?:\.toString\([^)]*\))?\}[^`\n]*`/g;

function positions(text: string, pattern: RegExp, fix: string, add: (offset: number, fix: string) => void) {
  for (const m of text.matchAll(pattern)) add(m.index, fix);
}

export function clockViolations(source: string): Violation[] {
  const text = source.replace(/^\s*(?:\/\/|\/\*|\*|#)[^\n]*/gm, comment => comment.replace(/[^\n]/g, " "));
  const hits: Violation[] = [];
  const add = (at: number, fix: string) => {
    const line = text.slice(0, at).split("\n").length;
    hits.push({ line, fix });
  };
  positions(text, value, boundary, add);
  for (const update of text.matchAll(/\bUPDATE\s+[\w.]+\s+(?:AS\s+\w+\s+)?SET\s+([^;`]*?)(?=\bWHERE\b|\bRETURNING\b|[;`]|$)/gi)) {
    const start = update.index + update[0].indexOf(update[1]!);
    positions(update[1]!, due, boundary, (at, fix) => add(start + at, fix));
  }
  positions(text, sleeps, wait, add);
  for (const m of text.matchAll(numberId)) {
    // A serial, UUID or random suffix supplies uniqueness independently of the clock.
    const before = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
    if (/\b(?:console\.(?:log|info|debug|warn|error)|new Error)\([^;]*$/.test(before)) continue;
    const extra = [...m[0].matchAll(/\$\{(?!Date\.now)([^}]+)\}/g)];
    if (extra.every(x => /^(?:(?:source|service|vendor|provider)(?:Id|Key)?|prefix)$/i.test(x[1]!.trim()))) add(m.index, id);
  }
  // A live timestamp stored in a local variable and then used as an audit/read cutoff.
  for (const block of text.split(/(?=^\s*(?:test|it)\s*\()/m)) {
    const start = text.indexOf(block);
    for (const m of block.matchAll(new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*${clock}\s*[;,]`, "g"))) {
      const used = new RegExp(String.raw`\b\w*(?:Since|Before|After)\s*\(\s*${m[1]}\b|\b(?:${fields})\s*:\s*${m[1]}\b(?!\s*[-+])`);
      const remaining = block.slice(m.index + m[0].length);
      const shorthand = new RegExp(`^(?:${fields})$`).test(m[1]!) && new RegExp(String.raw`[{,]\s*${m[1]}\s*[,}]`).test(remaining);
      if (used.test(remaining) || shorthand) add(start + m.index, boundary);
    }
  }
  // Split SQL rows only at top-level commas. now(), SQL functions and interpolations can themselves contain commas.
  for (const m of text.matchAll(/\bINSERT\s+INTO\s+[\w.]+\s*\(([^()]+)\)\s*VALUES\s*\(/gi)) {
    const columns = m[1]!.split(",").map(s => s.trim());
    let start = m.index + m[0].length, column = 0, depth = 0;
    const tokens = /'(?:''|[^'])*'|[(){},`]/g;
    tokens.lastIndex = start;
    for (let token; (token = tokens.exec(text));) {
      const char = token[0];
      if (char === "`") break;
      if (!depth && (char === "," || char === ")")) {
        const v = text.slice(start, token.index).trim();
        if (new RegExp(`^(?:${sqlFields})$`, "i").test(columns[column] ?? "") && new RegExp(`^${sqlClock}$`, "i").test(v)) add(start + text.slice(start, token.index).indexOf(v), boundary);
        if (char === ")") {
          const next = /^\s*,\s*\(/.exec(text.slice(tokens.lastIndex));
          if (!next) break;
          tokens.lastIndex += next[0].length;
          column = 0;
        } else column++;
        start = tokens.lastIndex;
      } else if (char === "(" || char === "{") depth++;
      else if (char === ")" || char === "}") depth--;
    }
  }
  return hits;
}

export function clockViolationsByFile() {
  const files = sourceFiles("*test*", "tests/**").filter(file => /(?:^|\/)(?:tests?\/|test_[^/]+\.py$)|\.(?:test|spec)\.[^/]+$/.test(file)
    && /\.(?:[cm]?[jt]sx?|py)$/.test(file) && !file.endsWith("/test-clock.ts"));
  return new Map(files.map(file => [file, clockViolations(readFileSync(path.join(root, file), "utf8"))]));
}
