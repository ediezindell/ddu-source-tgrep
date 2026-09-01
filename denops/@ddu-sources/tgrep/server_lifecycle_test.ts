import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path/join";
import { delay } from "@std/async/delay";
import {
  ensureServer,
  probeServer,
  readServeLog,
  type SpawnArgs,
  type SpawnResult,
  spawnServer,
  stopServer,
} from "./server.ts";

async function withRoot(
  fn: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "ddu-tgrep-" });
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function writeServeJson(
  root: string,
  info: { pid: number; port: number },
): Promise<void> {
  await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
  await Deno.writeTextFile(
    join(root, ".tgrep", "serve.json"),
    JSON.stringify(info),
  );
}

function listenLoopback(): Deno.Listener {
  return Deno.listen({ hostname: "127.0.0.1", port: 0 });
}

const noopDebug = () => Promise.resolve();

function fakeSpawn(
  commandLine: string[],
  stderr = "",
): SpawnResult {
  return { commandLine, detached: false, stderr: () => stderr };
}

Deno.test("readServeLog はログがまだ書かれていなければ空文字を返す", async () => {
  await withRoot((root) => {
    // Act & Assert
    assertEquals(readServeLog(root), "");
  });
});

Deno.test("readServeLog はサーバーが書き残した内容をそのまま返す", async () => {
  await withRoot(async (root) => {
    // Arrange
    await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
    await Deno.writeTextFile(
      join(root, ".tgrep", "serve.log"),
      "another tgrep server already holds the lock",
    );

    // Act & Assert
    assertEquals(
      readServeLog(root),
      "another tgrep server already holds the lock",
    );
  });
});

Deno.test("readServeLog は長すぎるログを先頭 4096 文字だけにして返す", async () => {
  await withRoot(async (root) => {
    // Arrange
    await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
    await Deno.writeTextFile(
      join(root, ".tgrep", "serve.log"),
      "x".repeat(5000),
    );

    // Act
    const log = readServeLog(root);

    // Assert
    assertEquals(log, "x".repeat(4096));
  });
});

Deno.test({
  name: "spawnServer はログの書き込み先ディレクトリを起動前に用意する",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRoot(async (root) => {
      // Act
      spawnServer({ cmd: "/bin/true", root, serveArgs: [] });

      // Assert
      assertEquals((await Deno.stat(join(root, ".tgrep"))).isDirectory, true);
    });
  },
});

Deno.test({
  name: "spawnServer はサーバーの stderr をログファイルへ向けて起動する",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRoot((root) => {
      // Act
      const { commandLine } = spawnServer({
        cmd: "/bin/true",
        root,
        serveArgs: [],
      });

      // Assert
      assertStringIncludes(
        commandLine.at(-1) ?? "",
        `2> '${join(root, ".tgrep", "serve.log")}'`,
      );
    });
  },
});

Deno.test({
  name: "spawnServer の stderr は起動したプロセスが書き残した内容を返す",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRoot(async (root) => {
      // Arrange: 引数を解釈できない cmd を使い、サーバー役にエラーを吐かせる
      const spawned = spawnServer({ cmd: "/bin/ls", root, serveArgs: [] });
      await delay(500);

      // Assert
      assertStringIncludes(spawned.stderr(), "serve");
    });
  },
});

Deno.test("probeServer は serve.json が無ければ undefined", async () => {
  await withRoot(async (root) => {
    assertEquals(await probeServer(root), undefined);
  });
});

Deno.test("probeServer は壊れた serve.json で throw する", async () => {
  await withRoot(async (root) => {
    await Deno.mkdir(join(root, ".tgrep"), { recursive: true });
    await Deno.writeTextFile(join(root, ".tgrep", "serve.json"), "{}");

    await assertRejects(() => probeServer(root), TypeError, 'invalid "pid"');
  });
});

Deno.test("ensureServer は既存サーバーがあれば spawn しない", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    await writeServeJson(root, { pid: Deno.pid, port });
    let spawned = 0;

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn: () => {
        spawned++;
        return fakeSpawn([]);
      },
      timeoutMs: 1000,
    });

    assertEquals(info, { pid: Deno.pid, port });
    assertEquals(spawned, 0);
    listener.close();
  });
});

Deno.test("ensureServer は spawn 直後の 1 回目の probe で見つかれば待たない", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;

    const spawn = (args: SpawnArgs): SpawnResult => {
      Deno.mkdirSync(join(args.root, ".tgrep"), { recursive: true });
      Deno.writeTextFileSync(
        join(args.root, ".tgrep", "serve.json"),
        JSON.stringify({ pid: Deno.pid, port }),
      );
      return fakeSpawn([args.cmd, "serve", args.root]);
    };

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn,
      timeoutMs: 0,
    });

    assertEquals(info, { pid: Deno.pid, port });
    listener.close();
  });
});

Deno.test("ensureServer は起動しなければ timeout エラーを投げる", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () => fakeSpawn(["tgrep", "serve", root]),
          timeoutMs: 300,
        }),
      Error,
      "server did not start",
    );
  });
});

Deno.test("ensureServer は timeout エラーに子プロセスの stderr を載せる", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () =>
            fakeSpawn(
              ["tgrep", "serve", root],
              "another tgrep server already holds the lock",
            ),
          timeoutMs: 300,
        }),
      Error,
      "another tgrep server already holds the lock",
    );
  });
});

Deno.test({
  name: "spawnServer は cmd が見つからなければ spawn せずに throw する",
  ignore: Deno.build.os === "windows",
  fn: () => {
    assertThrows(
      () =>
        spawnServer({
          cmd: "tgrep-not-installed-xyz",
          root: "/tmp",
          serveArgs: [],
        }),
      Error,
      "tgrep-not-installed-xyz",
    );
    assertThrows(
      () =>
        spawnServer({
          cmd: "/nonexistent/bin/tgrep",
          root: "/tmp",
          serveArgs: [],
        }),
      Error,
      "/nonexistent/bin/tgrep",
    );
  },
});

Deno.test("ensureServer は spawn が throw したら timeout を待たずに失敗する", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        ensureServer({
          cmd: "tgrep-not-installed-xyz",
          root,
          serveArgs: [],
          debug: noopDebug,
          spawn: () => {
            throw new Error(
              "tgrep: command not found: tgrep-not-installed-xyz",
            );
          },
          timeoutMs: 60_000,
        }),
      Error,
      "tgrep-not-installed-xyz",
    );
  });
});

Deno.test("ensureServer は spawn 後に serve.json が現れるまで待つ", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    let writing: Promise<void> | undefined;

    const spawn = (args: SpawnArgs): SpawnResult => {
      writing = (async () => {
        await delay(150);
        await writeServeJson(args.root, { pid: Deno.pid, port });
      })();
      return fakeSpawn([args.cmd, "serve", args.root]);
    };

    const info = await ensureServer({
      cmd: "tgrep",
      root,
      serveArgs: [],
      debug: noopDebug,
      spawn,
      timeoutMs: 3000,
    });
    await writing;

    assertEquals(info, { pid: Deno.pid, port });
    listener.close();
  });
});

Deno.test("probeServer は生きている pid と接続可能なポートを返す", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    await writeServeJson(root, { pid: Deno.pid, port });

    assertEquals(await probeServer(root), { pid: Deno.pid, port });

    listener.close();
  });
});

Deno.test("probeServer はポートに接続できなければ undefined", async () => {
  await withRoot(async (root) => {
    const listener = listenLoopback();
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    await writeServeJson(root, { pid: Deno.pid, port });

    assertEquals(await probeServer(root), undefined);
  });
});

Deno.test("stopServer は serve.json が無ければ throw する", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () => stopServer(root),
      Error,
      "no server info at",
    );
  });
});

Deno.test({
  name: "stopServer は serve.json の pid に SIGTERM を送る",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRoot(async (root) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "await new Promise((resolve) => setTimeout(resolve, 60_000));",
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        await writeServeJson(root, { pid: child.pid, port: 1 });

        const info = await stopServer(root);
        const status = await child.status;

        assertEquals(info.pid, child.pid);
        assertEquals(status.signal, "SIGTERM");
      } finally {
        try {
          child.kill();
        } catch {
          // Already reaped by the assertions above.
        }
      }
    });
  },
});

Deno.test({
  name: "probeServer は pid が死んでいれば接続できるポートでも undefined",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRoot(async (root) => {
      const listener = listenLoopback();
      const port = (listener.addr as Deno.NetAddr).port;

      const child = new Deno.Command(Deno.execPath(), {
        args: ["eval", "0"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const pid = child.pid;
      await child.status;

      await writeServeJson(root, { pid, port });

      assertEquals(await probeServer(root), undefined);

      listener.close();
    });
  },
});
