import { join } from "@std/path/join";

export function cacheBaseDir(): string {
  if (Deno.build.os === "windows") {
    const appdata = Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("APPDATA");
    const base = appdata ?? Deno.env.get("TEMP") ?? ".";
    return join(base, "ddu-source-tgrep");
  }
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const base = xdg && xdg.length !== 0
    ? xdg
    : join(Deno.env.get("HOME") ?? "/tmp", ".cache");
  return join(base, "ddu-source-tgrep");
}
