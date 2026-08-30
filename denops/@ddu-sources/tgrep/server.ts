import { join } from "@std/path/join";

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
