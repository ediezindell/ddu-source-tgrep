import { join } from "@std/path/join";
import { delay } from "@std/async/delay";
import type { DebugLogger } from "./debug.ts";

export const SPAWN_TIMEOUT_MS = 10_000;

const POLL_INTERVAL_MS = 100;
const STDERR_CAPTURE_BYTES = 4096;

export type ServerInfo = {
  pid: number;
  port: number;
};

export function serveJsonPath(root: string): string {
  return join(root, ".tgrep", "serve.json");
}

export function parseServeJson(text: string): ServerInfo {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("tgrep: serve.json is not a JSON object");
  }

  const { pid, port } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(
      `tgrep: serve.json has invalid "pid": ${JSON.stringify(pid)}`,
    );
  }
  if (
    typeof port !== "number" || !Number.isInteger(port) || port <= 0 ||
    port > 65535
  ) {
    throw new TypeError(
      `tgrep: serve.json has invalid "port": ${JSON.stringify(port)}`,
    );
  }

  return { pid, port };
}

export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (e: unknown) {
    // Only NotFound proves the process is gone. PermissionDenied (another
    // user's process) and Windows' unsupported-signal TypeError do not.
    return !(e instanceof Deno.errors.NotFound);
  }
}

export async function canConnect(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

export async function probeServer(
  root: string,
): Promise<ServerInfo | undefined> {
  const path = serveJsonPath(root);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw e;
  }

  const info = parseServeJson(text);
  if (!isProcessAlive(info.pid)) {
    return undefined;
  }
  return (await canConnect(info.port)) ? info : undefined;
}

export type SpawnArgs = {
  cmd: string;
  root: string;
  serveArgs: string[];
};

export type SpawnResult = {
  commandLine: string[];
  detached: boolean;
  stderr: () => string;
};

export type EnsureServerArgs = {
  cmd: string;
  root: string;
  serveArgs: string[];
  debug: DebugLogger;
  spawn: (args: SpawnArgs) => SpawnResult;
  timeoutMs: number;
};

function isExecutableInPath(name: string): boolean {
  if (Deno.build.os === "windows") {
    return false;
  }
  const paths = Deno.env.get("PATH");
  if (paths === undefined) {
    return false;
  }
  for (const dir of paths.split(":")) {
    if (dir.length === 0) {
      continue;
    }
    try {
      Deno.lstatSync(join(dir, name));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) {
    try {
      Deno.lstatSync(cmd);
      return true;
    } catch {
      return false;
    }
  }
  return isExecutableInPath(cmd);
}

export function spawnServer(args: SpawnArgs): SpawnResult {
  if (Deno.build.os !== "windows" && !commandExists(args.cmd)) {
    throw new Error(
      `tgrep: command not found: ${args.cmd} (install tgrep, or set the "cmd" source param to its path)`,
    );
  }

  const serveLine = [args.cmd, "serve", args.root, ...args.serveArgs];
  const detached = isExecutableInPath("setsid");
  const commandLine = detached ? ["setsid", ...serveLine] : serveLine;

  const child = new Deno.Command(commandLine[0], {
    args: commandLine.slice(1),
    cwd: args.root,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let captured = "";
  const decoder = new TextDecoder();
  (async () => {
    for await (const chunk of child.stderr) {
      if (captured.length < STDERR_CAPTURE_BYTES) {
        captured += decoder.decode(chunk, { stream: true });
      }
    }
  })().catch(() => {});
  child.unref();

  return {
    commandLine,
    detached,
    stderr: () => captured.slice(0, STDERR_CAPTURE_BYTES),
  };
}

export async function ensureServer(
  args: EnsureServerArgs,
): Promise<ServerInfo> {
  const path = serveJsonPath(args.root);

  const existing = await probeServer(args.root);
  if (existing !== undefined) {
    await args.debug(
      `connected to running server: root=${args.root} serveJson=${path} pid=${existing.pid} port=${existing.port}`,
    );
    return existing;
  }

  let spawned: SpawnResult;
  try {
    spawned = args.spawn({
      cmd: args.cmd,
      root: args.root,
      serveArgs: args.serveArgs,
    });
  } catch (e: unknown) {
    throw new Error(
      `tgrep: failed to spawn "${args.cmd} serve ${args.root}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  await args.debug(
    `spawned server: ${
      spawned.commandLine.join(" ")
    } detached=${spawned.detached}`,
  );

  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    const info = await probeServer(args.root);
    if (info !== undefined) {
      await args.debug(
        `server ready: root=${args.root} serveJson=${path} pid=${info.pid} port=${info.port} stderr=${
          JSON.stringify(spawned.stderr())
        }`,
      );
      return info;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }

  const stderr = spawned.stderr();
  throw new Error(
    `tgrep: server did not start within ${args.timeoutMs}ms (root=${args.root}, serveJson=${path})${
      stderr.length === 0 ? "" : `; stderr: ${stderr}`
    }`,
  );
}

export async function stopServer(root: string): Promise<ServerInfo> {
  const path = serveJsonPath(root);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e: unknown) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`tgrep: no server info at ${path}`);
    }
    throw e;
  }

  const info = parseServeJson(text);
  Deno.kill(info.pid, "SIGTERM");
  return info;
}
