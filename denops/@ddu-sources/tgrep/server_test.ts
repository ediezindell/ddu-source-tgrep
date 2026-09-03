import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import {
  buildServeCommandLine,
  isProcessAlive,
  parseServeJson,
  serveJsonPath,
} from "./server.ts";

Deno.test("serveJsonPath は <root>/.tgrep/serve.json を返す", () => {
  assertEquals(
    serveJsonPath(join("/tmp", "workspace")),
    join("/tmp", "workspace", ".tgrep", "serve.json"),
  );
});

Deno.test("serveJsonPath は索引置き場が指定されていればそちらを見る", () => {
  assertEquals(
    serveJsonPath(join("/tmp", "workspace"), join("/tmp", "cache", "entry")),
    join("/tmp", "cache", "entry", "serve.json"),
  );
});

Deno.test("serveJsonPath は索引置き場ごとに別の serve.json を指す", () => {
  assertEquals(
    serveJsonPath(join("/tmp", "workspace"), join("/tmp", "cache", "other")),
    join("/tmp", "cache", "other", "serve.json"),
  );
});

Deno.test("buildServeCommandLine は sh 経由でサーバーの stderr を .tgrep/serve.log に向ける", () => {
  // Arrange
  const root = join("/tmp", "workspace");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: true,
  });

  // Assert
  assertEquals(commandLine, [
    "sh",
    "-c",
    `exec 'tgrep' serve '${root}' 2> '${join(root, ".tgrep", "serve.log")}'`,
  ]);
});

Deno.test("buildServeCommandLine は serveArgs をリダイレクトより前に置く", () => {
  // Arrange
  const root = join("/tmp", "workspace");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: ["--no-watch"],
    setsid: false,
    shell: true,
  });

  // Assert
  assertEquals(commandLine, [
    "sh",
    "-c",
    `exec 'tgrep' serve '${root}' '--no-watch' 2> '${
      join(root, ".tgrep", "serve.log")
    }'`,
  ]);
});

Deno.test("buildServeCommandLine は setsid が使えるとき先頭に setsid を置く", () => {
  // Arrange
  const root = join("/tmp", "workspace");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: true,
    shell: true,
  });

  // Assert
  assertEquals(commandLine, [
    "setsid",
    "sh",
    "-c",
    `exec 'tgrep' serve '${root}' 2> '${join(root, ".tgrep", "serve.log")}'`,
  ]);
});

Deno.test("buildServeCommandLine は sh が無ければリダイレクトを諦めて直接起動する", () => {
  // Arrange
  const root = join("/tmp", "workspace");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: ["--no-watch"],
    setsid: false,
    shell: false,
  });

  // Assert
  assertEquals(commandLine, ["tgrep", "serve", root, "--no-watch"]);
});

Deno.test("buildServeCommandLine は空白とクォートを含むパスを 1 引数のまま渡す", () => {
  // Arrange
  const root = "/tmp/a b/it's";

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "/opt/my bin/tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: true,
  });

  // Assert
  assertEquals(commandLine, [
    "sh",
    "-c",
    "exec '/opt/my bin/tgrep' serve '/tmp/a b/it'\\''s' " +
    "2> '/tmp/a b/it'\\''s/.tgrep/serve.log'",
  ]);
});

Deno.test("buildServeCommandLine は sh が無くても指定された cmd と root を使う", () => {
  // Act
  const commandLine = buildServeCommandLine({
    cmd: "/opt/x/tgrep",
    root: "/srv/repo",
    serveArgs: [],
    setsid: false,
    shell: false,
  });

  // Assert
  assertEquals(commandLine, ["/opt/x/tgrep", "serve", "/srv/repo"]);
});

Deno.test("buildServeCommandLine は serveArgs のクォートもエスケープする", () => {
  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root: "/srv/repo",
    serveArgs: ["--exclude=it's"],
    setsid: false,
    shell: true,
  });

  // Assert
  assertEquals(
    commandLine[2],
    [
      "exec 'tgrep' serve '/srv/repo'",
      "'--exclude=it'\\''s'",
      "2> '/srv/repo/.tgrep/serve.log'",
    ].join(" "),
  );
});

Deno.test("parseServeJson は pid と port を取り出す", () => {
  assertEquals(parseServeJson('{"pid":4242,"port":54321}'), {
    pid: 4242,
    port: 54321,
  });
});

Deno.test("parseServeJson は pid が数値でないと throw する", () => {
  assertThrows(
    () => parseServeJson('{"pid":"4242","port":54321}'),
    TypeError,
    'invalid "pid"',
  );
});

Deno.test("parseServeJson は port が範囲外だと throw する", () => {
  assertThrows(
    () => parseServeJson('{"pid":4242,"port":70000}'),
    TypeError,
    'invalid "port"',
  );
});

Deno.test("parseServeJson は JSON オブジェクトでないと throw する", () => {
  assertThrows(
    () => parseServeJson("[1,2,3]"),
    TypeError,
    "not a JSON object",
  );
});

Deno.test("isProcessAlive は自分自身の pid に true を返す", () => {
  assertEquals(isProcessAlive(Deno.pid), true);
});

Deno.test({
  name: "isProcessAlive は終了済みプロセスの pid に false を返す",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "0"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const pid = child.pid;
    await child.status;

    assertEquals(isProcessAlive(pid), false);
  },
});

Deno.test("buildServeCommandLine は索引置き場をサーバーに伝える", () => {
  // Arrange
  const root = join("/tmp", "workspace");
  const indexPath = join("/tmp", "cache", "entry");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: true,
    indexPath,
  });

  // Assert
  assertEquals(
    commandLine[2].includes(`--index-path '${indexPath}'`),
    true,
    commandLine[2],
  );
});

Deno.test("buildServeCommandLine は索引置き場ごとに違う場所をサーバーに伝える", () => {
  // Arrange
  const root = join("/tmp", "workspace");
  const indexPath = join("/tmp", "cache", "other");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: true,
    indexPath,
  });

  // Assert
  assertEquals(
    commandLine[2].includes(`--index-path '${indexPath}'`),
    true,
    commandLine[2],
  );
});

Deno.test("buildServeCommandLine は索引置き場を使うときサーバーのログもそこへ書かせる", () => {
  // Arrange
  const root = join("/tmp", "workspace");
  const indexPath = join("/tmp", "cache", "entry");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: true,
    indexPath,
  });

  // Assert
  assertEquals(
    commandLine[2].endsWith(`2> '${join(indexPath, "serve.log")}'`),
    true,
    commandLine[2],
  );
});

Deno.test("buildServeCommandLine は sh が無くても索引置き場をサーバーに伝える", () => {
  // Arrange
  const root = join("/tmp", "workspace");
  const indexPath = join("/tmp", "cache", "entry");

  // Act
  const commandLine = buildServeCommandLine({
    cmd: "tgrep",
    root,
    serveArgs: [],
    setsid: false,
    shell: false,
    indexPath,
  });

  // Assert
  assertEquals(commandLine, [
    "tgrep",
    "serve",
    root,
    "--index-path",
    indexPath,
  ]);
});
