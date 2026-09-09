import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import type { ActionData } from "@shougo/ddu-kind-file";
import {
  BaseSource,
  type GatherArguments,
  type OnEventArguments,
  type OnInitArguments,
} from "@shougo/ddu-vim/source";
import type { Item } from "@shougo/ddu-vim/types";
import { printError, treePath2Filename } from "@shougo/ddu-vim/utils";
import { join } from "@std/path/join";

import { createDebugLogger } from "./debug.ts";
import { cacheBaseDir } from "./cache.ts";
import { parseGitignore } from "./gitignore.ts";
import { findHiddenDirs, hiddenIndexPath } from "./hidden.ts";
import {
  type CaseMode,
  type HighlightGroup,
  matchRowsToItems,
  parseSearchResult,
  resolveCaseInsensitive,
} from "./item.ts";
import { pathExists, resolveRootFrom } from "./root.ts";
import { isRegexSyntaxError, RpcMethodError, RpcSession } from "./rpc.ts";
import { combineGlobs, resolveScope, type Scope } from "./scope.ts";
import {
  ensureServer,
  type EnsureServerArgs,
  type ServerInfo,
  SPAWN_TIMEOUT_MS,
  type SpawnArgs,
  type SpawnResult,
  spawnServer,
} from "./server.ts";

const ENQUEUE_SIZE_1ST = 1000;

export type Params = {
  cmd: string;
  input: string;
  scope: Scope;
  rootMarkers: string[];
  globs: string[];
  caseMode: CaseMode;
  fixedString: boolean;
  types: string[];
  maxItems: number;
  minInputLength: number;
  highlights: HighlightGroup;
  serveArgs: string[];
  debug: boolean;
};

export type DirEntry = { name: string; isDirectory: boolean };

export type SourceDeps = {
  ensureServer?: (args: EnsureServerArgs) => Promise<ServerInfo>;
  spawn?: (args: SpawnArgs) => SpawnResult;
  listEntries?: (root: string) => Promise<DirEntry[]>;
  readGitignore?: (root: string) => Promise<string>;
  cacheBaseDir?: () => string;
};

async function currentCwd(denops: Denops): Promise<string> {
  return await fn.getcwd(denops) as string;
}

function reportKey(value: unknown): string {
  return value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
}

async function listRootEntries(root: string): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const entry of Deno.readDir(root)) {
    entries.push({ name: entry.name, isDirectory: entry.isDirectory });
  }
  return entries;
}

async function readRootGitignore(root: string): Promise<string> {
  try {
    return await Deno.readTextFile(join(root, ".gitignore"));
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return "";
    }
    throw e;
  }
}

async function searchServer(args: {
  server: ServerEntry;
  pattern: string;
  caseInsensitive: boolean;
  fixedString: boolean;
  glob?: string[];
  types: string[];
  highlights: HighlightGroup;
  maxItems: number;
  signal: AbortSignal;
}): Promise<Item<ActionData>[]> {
  const raw = await args.server.session.call("search", {
    pattern: args.pattern,
    case_insensitive: args.caseInsensitive,
    fixed_string: args.fixedString,
    glob: args.glob ?? [],
    types: args.types,
    detail: true,
    positions: false,
  }, args.signal);
  const result = parseSearchResult(raw);
  return matchRowsToItems({
    rows: result.matches,
    root: args.server.root,
    highlights: args.highlights,
    maxItems: args.maxItems,
  });
}

type ServerEntry = {
  session: RpcSession;
  root: string;
};

export class Source extends BaseSource<Params> {
  override kind = "file";

  #root = "";
  #servers: ServerEntry[] = [];
  #reported = new Set<string>();
  #ensureServer: (args: EnsureServerArgs) => Promise<ServerInfo>;
  #spawn: (args: SpawnArgs) => SpawnResult;
  #listEntries: (root: string) => Promise<DirEntry[]>;
  #readGitignore: (root: string) => Promise<string>;
  #cacheBaseDir: () => string;

  constructor(deps: SourceDeps = {}) {
    super();
    this.#ensureServer = deps.ensureServer ?? ensureServer;
    this.#spawn = deps.spawn ?? spawnServer;
    this.#listEntries = deps.listEntries ?? listRootEntries;
    this.#readGitignore = deps.readGitignore ?? readRootGitignore;
    this.#cacheBaseDir = deps.cacheBaseDir ?? cacheBaseDir;
  }

  override async onInit(args: OnInitArguments<Params>): Promise<void> {
    const debug = createDebugLogger(args.denops, args.sourceParams.debug);
    const sourcePath = args.sourceOptions.path.length !== 0
      ? treePath2Filename(args.sourceOptions.path)
      : "";
    this.#root = resolveRootFrom({
      sourcePath,
      cwd: await currentCwd(args.denops),
      exists: pathExists,
    });

    this.#reported.clear();
    this.#closeServers();

    let mainServer: ServerEntry;
    try {
      const main = await this.#ensureServer({
        cmd: args.sourceParams.cmd,
        root: this.#root,
        serveArgs: args.sourceParams.serveArgs,
        debug,
        spawn: this.#spawn,
        timeoutMs: SPAWN_TIMEOUT_MS,
      });
      mainServer = { session: new RpcSession(main.port), root: this.#root };
    } catch (e: unknown) {
      await this.#reportOnce(args.denops, e);
      return;
    }

    const servers: ServerEntry[] = [mainServer];
    let hiddenDirs: string[];
    try {
      hiddenDirs = await this.#hiddenDirs();
    } catch (e: unknown) {
      await debug(`failed to discover hidden dirs: ${reportKey(e)}`);
      hiddenDirs = [];
    }
    for (const dir of hiddenDirs) {
      try {
        const indexPath = hiddenIndexPath({
          cacheBase: this.#cacheBaseDir(),
          root: this.#root,
          dir,
        });
        const info = await this.#ensureServer({
          cmd: args.sourceParams.cmd,
          root: join(this.#root, dir),
          indexPath,
          serveArgs: args.sourceParams.serveArgs,
          debug,
          spawn: this.#spawn,
          timeoutMs: SPAWN_TIMEOUT_MS,
        });
        servers.push({
          session: new RpcSession(info.port),
          root: join(this.#root, dir),
        });
      } catch (e: unknown) {
        await debug(`failed to start hidden server for ${dir}: ${reportKey(e)}`);
      }
    }

    this.#servers = servers;
    await debug(
      `initialized ${servers.length} server(s): root=${this.#root} hidden=${
        JSON.stringify(servers.slice(1).map((s) => s.root))
      }`,
    );
  }

  async #hiddenDirs(): Promise<string[]> {
    const entries = await this.#listEntries(this.#root);
    const ignored = parseGitignore(await this.#readGitignore(this.#root));
    return findHiddenDirs({ entries, isIgnored: ignored });
  }

  #reportOnce(denops: Denops, error: unknown): Promise<void> {
    const key = reportKey(error);
    if (this.#reported.has(key)) {
      return Promise.resolve();
    }
    this.#reported.add(key);
    return printError(denops, error);
  }

  #closeServers(): void {
    for (const server of this.#servers) {
      server.session.close();
    }
    this.#servers = [];
  }

  override onEvent(args: OnEventArguments<Params>): void {
    if (args.event === "close" || args.event === "cancel") {
      this.#closeServers();
    }
  }

  gather(args: GatherArguments<Params>): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const root = this.#root;
    const servers = this.#servers;
    const params = args.sourceParams;
    const reportOnce = (error: unknown) => this.#reportOnce(args.denops, error);

    return new ReadableStream({
      async start(controller) {
        const debug = createDebugLogger(args.denops, params.debug);
        let input = params.input;
        try {
          input = args.sourceOptions.volatile ? args.input : params.input;
          if (input.length < params.minInputLength) {
            return;
          }
          if (servers.length === 0) {
            await reportOnce(
              "tgrep: the server is unavailable. See :messages for the failure reported while the source was initialized.",
            );
            return;
          }

          const cwd = await currentCwd(args.denops);
          const scopeGlobs = combineGlobs(
            resolveScope({
              scope: params.scope,
              root,
              cwd,
              markers: params.rootMarkers,
              exists: pathExists,
            }),
            params.globs,
          );
          const caseInsensitive = resolveCaseInsensitive(
            params.caseMode,
            input,
          );
          await debug(
            `search: pattern=${input} glob=${
              JSON.stringify(scopeGlobs)
            } case_insensitive=${caseInsensitive} servers=${servers.length}`,
          );

          const startedAt = Date.now();
          const requests = servers.map((server) =>
            searchServer({
              server,
              pattern: input,
              caseInsensitive,
              fixedString: params.fixedString,
              glob: server.root === root ? scopeGlobs : params.globs,
              types: params.types,
              highlights: params.highlights,
              maxItems: params.maxItems,
              signal: abortController.signal,
            })
          );
          const results = await Promise.all(requests);

          const items = results.flatMap((result) => result).slice(
            0,
            params.maxItems,
          );
          await debug(
            `search done: items=${items.length} roundtrip_ms=${
              Date.now() - startedAt
            }`,
          );

          if (items.length !== 0) {
            controller.enqueue(items.slice(0, ENQUEUE_SIZE_1ST));
          }
          if (items.length > ENQUEUE_SIZE_1ST) {
            controller.enqueue(items.slice(ENQUEUE_SIZE_1ST));
          }
        } catch (e: unknown) {
          if (abortController.signal.aborted) {
            await debug(`search discarded as stale: pattern=${input}`);
          } else if (e instanceof RpcMethodError && isRegexSyntaxError(e)) {
            await debug(`ignored regex syntax error: ${e.message}`);
          } else {
            await reportOnce(e);
          }
        } finally {
          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  params(): Params {
    return {
      cmd: "tgrep",
      input: "",
      scope: "all",
      rootMarkers: [
        "package.json",
        "deno.json",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
      ],
      globs: [],
      caseMode: "smart",
      fixedString: false,
      types: [],
      maxItems: 10000,
      minInputLength: 2,
      highlights: {
        path: "Normal",
        lineNr: "Normal",
        word: "Search",
      },
      serveArgs: [],
      debug: false,
    };
  }
}
