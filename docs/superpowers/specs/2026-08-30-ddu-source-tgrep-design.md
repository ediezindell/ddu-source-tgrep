# ddu-source-tgrep 設計

2026-08-30 承認済み。

## 概要

[tgrep](https://github.com/microsoft/tgrep)(Rust 製・trigram インデックス付き grep)を backend にした
[ddu.vim](https://github.com/Shougo/ddu.vim) の source プラグイン。
プラグインが tgrep サーバーを立て(または既存サーバーに接続し)、TCP JSON-RPC で検索リクエストを送って
結果を ddu の items として返す。live grep(volatile)を主用途とする。

## 前提: tgrep のプロトコル

- `tgrep serve <root>` で TCP サーバーが起動し、`<root>/.tgrep/serve.json` に pid とポートを書き出す
- プロトコルは改行区切り TCP 上の JSON-RPC 2.0。メソッドは `search` / `status` / `reload` の 3 つ
- ストリーミング・キャンセル機構は無し(1 リクエスト = 1 レスポンス)
- 多重起動は flock で拒否される。インデックス構築中も部分結果で即応答する
- `search` の params に `pattern` / `case_insensitive` / `fixed_string` / `glob`(`!` 前置で除外)/
  `types` / `max_count` 等がある。`detail` / `positions` 有効時は spans(マッチ範囲)が返る

## アーキテクチャ

### ファイル構成

```
denops/@ddu-sources/tgrep/main.ts    # Source 本体(gather / params / onInit)
denops/@ddu-sources/tgrep/server.ts  # サーバー検出・起動・停止
denops/@ddu-sources/tgrep/rpc.ts     # TCP JSON-RPC クライアント(改行区切り)
denops/@ddu-sources/tgrep/deno.json  # パッケージ定義(imports 固定)
deno.jsonc                           # workspace + tasks(check/lint/fmt/test)
plugin/ + autoload/                  # :DduTgrepStop コマンドのみ(起動コマンドは作らず doc に設定例)
doc/ddu-source-tgrep.txt
```

ddu の source 規約(`denops/@ddu-sources/{name}/main.ts` + `export class Source extends BaseSource`、
kind は `file`)に従う。参考実装は ddu-source-rg。

### root の決定(検索対象 = サーバーの単位)

`sourceOptions.path` → 無ければ cwd から `.git` を遡って git root → 見つからなければ cwd。

### サーバーライフサイクル(server.ts)

1. `<root>/.tgrep/serve.json` を読み、pid 生存 + TCP 接続確認できれば既存サーバーに接続
2. 無ければ `tgrep serve <root>` を detached で spawn(`unref` + プロセスグループ分離)。
   serve.json が現れるまで短いポーリングで待って接続。flock で先を越された場合(多重 Vim 等)は
   serve.json を読み直して接続に切替
3. 起動タイミングは `onInit`(ddu が UI 描画前に完了を待つ)
4. プラグインはサーバーを kill しない(Vim 終了後も残し、次回セッションで再利用)。
   停止は `:DduTgrepStop` が serve.json の pid に SIGTERM を送る
5. 検索中に接続が切れたら再接続を 1 回試み、ダメならエラー表示

### 検索範囲の絞り込み(scope)

- `scope: "all"`(デフォルト)= root 全体 / `"cwd"` = cwd 配下 / `"marker"` = rootMarkers 探索
- `"marker"` は lspconfig の root_markers と同じ規則: cwd からサーバー root まで上方向に遡り、
  `rootMarkers` のいずれかを含む最初のディレクトリを検索範囲にする。
  見つからなければエラー表示(黙って all に広げない)
- 絞り込みは、決まったディレクトリの root 相対パスを `glob: ["<relpath>/**"]` として
  search リクエストに付与して実現する

## 検索フロー(gather)

1. 検索語は `sourceOptions.volatile` が true なら `args.input`、false なら `sourceParams.input`。
   doc では volatile + `matchers: []` を live grep の推奨設定として案内する
2. 入力が `minInputLength` 未満なら何もせず close
3. RPC `search` を 1 回送信。`caseMode: "smart"` は入力に大文字が無いときだけ
   `case_insensitive: true` にするクライアント側変換
4. レスポンスを items に変換して 2 段チャンクで enqueue
   (最初の 1000 件を先に流して UI 反映を早め、残りをまとめて流す)
5. stale レスポンスの破棄: サーバーにキャンセル機構が無いため、gather ごとに JSON-RPC id を採番し、
   ReadableStream の cancel 後に届いたレスポンスは id 不一致で捨てる。ソケットは張りっぱなしで使い回す
6. 総件数は `maxItems` でクライアント側打ち切り

## item 生成

kind は `file`(ddu-kind-file の契約に従う)。

- `word`: `"path:line:col: text"`
- `action`: `{ path: root 基準の絶対パス, lineNr, col, text }`
- `highlights`: パス / 行番号 / マッチ語の 3 種。マッチ語の位置はレスポンスの spans から算出し、
  col / width は UTF-8 バイト長で計算(マルチバイト対応)

## source params

| param | default | 説明 |
|---|---|---|
| `cmd` | `"tgrep"` | 実行ファイル(serve 起動に使用) |
| `input` | `""` | 非 volatile 時の検索語 |
| `scope` | `"all"` | `"all"` / `"cwd"` / `"marker"` |
| `rootMarkers` | `["package.json", "deno.json", "Cargo.toml", "go.mod", "pyproject.toml"]` | `scope: "marker"` 時の探索対象 |
| `globs` | `[]` | 追加 glob(`!` 除外可、RPC にそのまま渡す) |
| `caseMode` | `"smart"` | `smart` / `sensitive` / `insensitive` |
| `fixedString` | `false` | 固定文字列検索 |
| `types` | `[]` | ripgrep 互換ファイルタイプ(`-t` 相当) |
| `maxItems` | `10000` | クライアント側打ち切り件数 |
| `minInputLength` | `2` | これ未満の入力では検索しない |
| `highlights` | path / lineNr / word 各 hl_group | ddu-source-rg と同形式 |
| `serveArgs` | `[]` | `tgrep serve` への追加引数(`--no-watch` 等) |
| `debug` | `false` | デバッグ出力(下記) |

### debug mode

`debug: true` のとき、以下を `:messages`(echomsg)に出力する:

- サーバー解決の経緯: 既存サーバーへの接続か新規 spawn か、serve.json のパス、ポート、root、
  spawn した場合はコマンドライン全体
- 各 search のリクエスト概要(pattern / 付与した glob / caseMode の解決結果)と、
  結果件数・所要時間・stale として破棄したかどうか

## エラー処理

fail-loud を原則とする。

- tgrep バイナリ不在 / サーバー起動失敗 / 接続失敗 → `printError` で明示表示。
  スタンドアロン検索(サーバー非経由)への silent fallback はしない
- RPC エラーのうち regex 構文エラーだけは無視して空結果にする
  (live grep では入力途中の不正 regex が毎打鍵発生するため)。それ以外の RPC エラーは表示
- `scope: "marker"` で marker が見つからない場合はエラー表示(all に広げない)

## 検証方針

- `deno task check` / `lint` / `fmt` / `test`(ddu-source-rg と同じ workspace 構成)
- unit test はレスポンス→item 変換 / scope 解決 / serve.json パース等の純ロジック中心
- 実機検証には tgrep のインストールが必要(cargo install または GitHub Releases)

## 初版で見送るもの

- `category`(ファイル見出し行)— ddu-source-rg にある機能。後付け可能
- migemo(kensaku.vim)対応
- 外部で立てたサーバーの status 監視・reload 操作
