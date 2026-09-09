import { assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import { cacheBaseDir } from "./cache.ts";

Deno.test("cacheBaseDir は XDG_CACHE_HOME の下に ddu-source-tgrep を置く", () => {
  const previous = Deno.env.get("XDG_CACHE_HOME");
  Deno.env.set("XDG_CACHE_HOME", "/custom/cache");
  try {
    assertEquals(cacheBaseDir(), join("/custom/cache", "ddu-source-tgrep"));
  } finally {
    if (previous === undefined) {
      Deno.env.delete("XDG_CACHE_HOME");
    } else {
      Deno.env.set("XDG_CACHE_HOME", previous);
    }
  }
});
