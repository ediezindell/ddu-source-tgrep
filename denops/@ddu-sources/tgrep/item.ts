import type { ActionData } from "@shougo/ddu-kind-file";
import type { Item, ItemHighlight } from "@shougo/ddu-vim/types";
import { resolve } from "@std/path/resolve";

export type CaseMode = "smart" | "sensitive" | "insensitive";

export type HighlightGroup = {
  path: string;
  lineNr: string;
  word: string;
};

export type SearchResult = {
  matches: unknown[];
  numMatches: number;
  elapsedMs: number;
};

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function resolveCaseInsensitive(
  mode: CaseMode,
  input: string,
): boolean {
  switch (mode) {
    case "smart":
      return input === input.toLowerCase();
    case "sensitive":
      return false;
    case "insensitive":
      return true;
    default:
      throw new TypeError(`tgrep: unknown caseMode: ${String(mode)}`);
  }
}

export function parseSearchResult(value: unknown): SearchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tgrep: search result is not a JSON object");
  }

  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.matches)) {
    throw new TypeError('tgrep: search result has no "matches" array');
  }
  if (
    typeof object.num_matches !== "number" ||
    typeof object.elapsed_ms !== "number"
  ) {
    throw new TypeError(
      'tgrep: search result has invalid "num_matches" or "elapsed_ms"',
    );
  }

  return {
    matches: object.matches,
    numMatches: object.num_matches,
    elapsedMs: object.elapsed_ms,
  };
}

export function matchRowToItem(args: {
  row: unknown;
  root: string;
  highlights: Partial<HighlightGroup>;
}): Item<ActionData> | undefined {
  if (args.row === null || typeof args.row !== "object") {
    throw new TypeError("tgrep: match row is not a JSON object");
  }

  const row = args.row as Record<string, unknown>;
  if (row.type !== "match") {
    return undefined;
  }

  const { file, line, content } = row;
  if (
    typeof file !== "string" || typeof line !== "number" ||
    typeof content !== "string"
  ) {
    throw new TypeError(`tgrep: malformed match row: ${JSON.stringify(row)}`);
  }

  if (!Array.isArray(row.spans) || row.spans.length === 0) {
    throw new TypeError(
      `tgrep: match row has no "spans": ${JSON.stringify(row)}`,
    );
  }
  const span: unknown = row.spans[0];
  if (
    !Array.isArray(span) || typeof span[0] !== "number" ||
    typeof span[1] !== "number"
  ) {
    throw new TypeError(
      `tgrep: match row has malformed "spans": ${JSON.stringify(row)}`,
    );
  }
  const startByte: number = span[0];
  const endByte: number = span[1];

  if (
    !Array.isArray(row.columns) || typeof row.columns[0] !== "number"
  ) {
    throw new TypeError(
      `tgrep: match row has no "columns": ${JSON.stringify(row)}`,
    );
  }
  const col: number = row.columns[0];

  const text = content.replace(/\r?\n$/, "");
  const header = `${file}:${line}:${col}: `;

  const hlGroupPath = args.highlights.path ?? "";
  const hlGroupLineNr = args.highlights.lineNr ?? "";
  const hlGroupWord = args.highlights.word ?? "";

  const highlights: ItemHighlight[] = [];
  if (hlGroupPath !== "") {
    highlights.push({
      name: "path",
      hl_group: hlGroupPath,
      col: 1,
      width: utf8Length(file),
    });
  }
  if (hlGroupLineNr !== "") {
    highlights.push({
      name: "lineNr",
      hl_group: hlGroupLineNr,
      col: utf8Length(file) + 2,
      width: utf8Length(String(line)),
    });
  }
  if (hlGroupWord !== "" && endByte > startByte) {
    highlights.push({
      name: "word",
      hl_group: hlGroupWord,
      col: utf8Length(header) + startByte + 1,
      width: endByte - startByte,
    });
  }

  return {
    word: header + text,
    action: {
      path: resolve(args.root, file),
      lineNr: line,
      col,
      text,
    },
    highlights,
  };
}

export function matchRowsToItems(args: {
  rows: unknown[];
  root: string;
  highlights: Partial<HighlightGroup>;
  maxItems: number;
}): Item<ActionData>[] {
  const items: Item<ActionData>[] = [];
  for (const row of args.rows) {
    if (items.length >= args.maxItems) {
      break;
    }
    const item = matchRowToItem({
      row,
      root: args.root,
      highlights: args.highlights,
    });
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items;
}
