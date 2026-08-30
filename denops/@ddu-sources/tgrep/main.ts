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

import { createDebugLogger } from "./debug.ts";
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

export type SourceDeps = {
  ensureServer?: (args: EnsureServerArgs) => Promise<ServerInfo>;
  spawn?: (args: SpawnArgs) => SpawnResult;
};

async function currentCwd(denops: Denops): Promise<string> {
  return await fn.getcwd(denops) as string;
}

function reportKey(value: unknown): string {
  return value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
}

export class Source extends BaseSource<Params> {
  override kind = "file";

  #root = "";
  #session: RpcSession | undefined;
  #reported = new Set<string>();
  #ensureServer: (args: EnsureServerArgs) => Promise<ServerInfo>;
  #spawn: (args: SpawnArgs) => SpawnResult;

  constructor(deps: SourceDeps = {}) {
    super();
    this.#ensureServer = deps.ensureServer ?? ensureServer;
    this.#spawn = deps.spawn ?? spawnServer;
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
    this.#session?.close();
    this.#session = undefined;
    try {
      const info = await this.#ensureServer({
        cmd: args.sourceParams.cmd,
        root: this.#root,
        serveArgs: args.sourceParams.serveArgs,
        debug,
        spawn: this.#spawn,
        timeoutMs: SPAWN_TIMEOUT_MS,
      });
      this.#session = new RpcSession(info.port);
    } catch (e: unknown) {
      await this.#reportOnce(args.denops, e);
    }
  }

  #reportOnce(denops: Denops, error: unknown): Promise<void> {
    const key = reportKey(error);
    if (this.#reported.has(key)) {
      return Promise.resolve();
    }
    this.#reported.add(key);
    return printError(denops, error);
  }

  override onEvent(args: OnEventArguments<Params>): void {
    if (args.event === "close" || args.event === "cancel") {
      this.#session?.close();
    }
  }

  gather(args: GatherArguments<Params>): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const root = this.#root;
    const session = this.#session;
    const params = args.sourceParams;
    const reportOnce = (error: unknown) => this.#reportOnce(args.denops, error);

    return new ReadableStream({
      async start(controller) {
        const debug = createDebugLogger(args.denops, params.debug);
        try {
          const input = args.sourceOptions.volatile ? args.input : params.input;
          if (input.length < params.minInputLength) {
            return;
          }
          if (session === undefined) {
            await reportOnce(
              "tgrep: the server is unavailable. See :messages for the failure reported while the source was initialized.",
            );
            return;
          }

          const globs = combineGlobs(
            resolveScope({
              scope: params.scope,
              root,
              cwd: await currentCwd(args.denops),
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
              JSON.stringify(globs)
            } case_insensitive=${caseInsensitive}`,
          );

          const startedAt = Date.now();
          const raw = await session.call("search", {
            pattern: input,
            case_insensitive: caseInsensitive,
            fixed_string: params.fixedString,
            glob: globs,
            types: params.types,
            detail: true,
            positions: false,
          }, abortController.signal);

          const result = parseSearchResult(raw);
          const items = matchRowsToItems({
            rows: result.matches,
            root,
            highlights: params.highlights,
            maxItems: params.maxItems,
          });
          await debug(
            `search done: items=${items.length} num_matches=${result.numMatches} elapsed_ms=${result.elapsedMs} roundtrip_ms=${
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
            await debug(`search discarded as stale: pattern=${args.input}`);
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
