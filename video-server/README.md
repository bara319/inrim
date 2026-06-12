# 韻リム 動画生成サーバー

スマホ（特にiPhone/Safari）で動画生成を安定させるためのサーバーです。

録音音声・歌詞・お題・写真背景を受け取り、アプリ内と同じ見た目
（写真背景 / レインボー波形 / 流れる歌詞 / お題は脇役 / 韻リム表記は小さめ）の
縦型MP4（720x1280, H.264+AAC）をサーバー側で描画して返します。

node-canvas が使えない環境では、自動的に「静止サムネ＋音声」のMP4に
フォールバックするので、デプロイが止まることはありません。

## API

`POST /render`

FormData:

- `audio`: 録音ファイル（必須。m4a/webm/ogg なんでもOK、ffmpegが自動判別）
- `poster`: サムネ画像（フォールバック用。なるべく送る）
- `photo`: 背景写真（あれば動画の背景に使う）
- `topic`: お題
- `lyrics`: リリック（改行区切り）
- `beat`: ビート名
- `color`: 色（#rrggbb）
- `bpm`: BPM

レスポンス: `video/mp4`（長さは音声に合わせて最大31秒）

`GET /healthz` → `{"ok":true,"dynamic":true}` dynamicがtrueなら動的レンダリング有効。

## 環境変数

- `PORT`: ポート（デフォルト3000）
- `RENDER_FPS`: 動画FPS（デフォルト24。遅いサーバーなら15に下げてもOK）
- `MAX_CONCURRENT_RENDERS`: 同時レンダリング数（デフォルト1。無料プラン向け）

## Renderへのデプロイ

1. このリポジトリをGitHubへpush
2. Render で「New +」→「Web Service」→ リポジトリを選択
3. Root Directory に `video-server` を指定（render.yamlを使う場合は不要）
4. Runtime: Docker のままデプロイ
5. デプロイ後、`https://〇〇.onrender.com/healthz` で `"dynamic":true` を確認

※無料プランは15分アクセスがないとスリープし、再起動に1分ほどかかります。
　最初の1回が遅いのはそのせいです。

## 公開後にアプリへつなぐ

`publish/index.html`（と `韻リム_22.html`）のこの行を、公開したサーバーURLに変えます。

```js
const VIDEO_API_URL = "https://あなたのサーバー.onrender.com/render";
```

GitHub PagesのURLはそのままで、動画生成ボタンだけサーバーへ送る形になります。

## スマホでの流れ

1. 録音する
2. 「🎬 この見た目で縦型動画を作る」→ サーバーがMP4を生成
3. 「📤 動画を保存 / 共有する」→ iPhoneの共有シートが開く
   - LINE: そのまま送れる
   - Instagram/TikTok: 「ビデオを保存」→ アプリから投稿
