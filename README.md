# nijiiro

nijiiro は、GitHub リポジトリをストレージとして使用するサーバーレスの ATProtocol PDS プロキシです。

## 概要

- ATProto リポジトリのデータ (ブロック、ref) を GitHub リポジトリにファイルとして保存します
- DID の解決には `did:web` を使用します

## 前提条件

- [Deno](https://deno.com/) v2 以上
- GitHub アカウントと、ブロックストレージ用の**空のリポジトリ**
- HTTPS に対応した管理下のドメイン (例: `example.com`)
- そのドメインで `/.well-known/did.json` を静的ファイルとして配信できること

## セットアップ

### 1. 秘密鍵とパスワードの生成

```sh
deno task setup
```

以下のような出力が得られます:

```
REPO_SIGNING_KEY=<hex>
JWT_SECRET=<hex>
ADMIN_PASSWORD=<base64>
REPO_SIGNING_KEY_DID=did:key:z...
```

`REPO_SIGNING_KEY_DID` は次のステップで使用するため、メモしておいてください。

### 2. DID ドキュメントの作成

ドメインの `/.well-known/did.json` を HTTPS で配信できるよう作成します。

以下のプレースホルダーを置き換えてください:

- `<your-domain>` — 使用するドメイン (例: `example.com`)
- `<your-handle>` — AT Protocol のハンドル (例: `example.com`)
- `<REPO_SIGNING_KEY_DID>` — ステップ 1 で出力された `did:key:z...` の `z...` 部分のみ (`did:key:` プレフィックスは含めない)
- `<your-pds-url>` — このサーバーの公開 URL (例: `https://pds.example.com`)

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1"
  ],
  "id": "did:web:<your-domain>",
  "alsoKnownAs": ["at://<your-handle>"],
  "verificationMethod": [
    {
      "id": "did:web:<your-domain>#atproto",
      "type": "Multikey",
      "controller": "did:web:<your-domain>",
      "publicKeyMultibase": "<REPO_SIGNING_KEY_DID>"
    }
  ],
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "<your-pds-url>"
    }
  ]
}
```

配信できているか確認します:

```sh
curl https://<your-domain>/.well-known/did.json
```

### 3. GitHub personal access token の作成

GitHub > Settings > Developer settings > Personal access tokens から、ストレージ用リポジトリに対して **Contents** の読み書き権限を持つトークンを作成します。

### 4. 環境変数の設定

`.env.example` を `.env` にコピーして、各値を埋めます:

```sh
cp .env.example .env
```

```env
GITHUB_TOKEN=<GitHub トークン>
GITHUB_OWNER=<GitHub ユーザー名>
GITHUB_REPO=<ストレージ用リポジトリ名>

REPO_DID=did:web:<your-domain>
REPO_HANDLE=<your-handle>
REPO_SIGNING_KEY=<ステップ 1 の値>

JWT_SECRET=<ステップ 1 の値>
ADMIN_PASSWORD=<ステップ 1 の値>
```

`GITHUB_BRANCH` は省略可能で、デフォルトは `main` です。

### 5. サーバーの起動

```sh
deno task start
```

サーバーはポート `8000` で起動します。

## ハンドルの DNS 検証

AT Protocol のハンドル検証を DNS で行う場合、ドメインに TXT レコードを追加します:

```
_atproto.<your-handle>  TXT  "did=did:web:<your-domain>"
```

ハンドルとドメインが同一の場合は `_atproto.<your-domain>` に追加します。

## リレーへの登録

セットアップ完了後、Bluesky のリレーにクロールをリクエストして AppView にインデックスされるようにします。

```sh
curl -X POST https://bsky.network/xrpc/com.atproto.sync.requestCrawl \
  -H "Content-Type: application/json" \
  -d '{"hostname": "<your-pds-hostname>"}'
```

`<your-pds-hostname>` はスキームなしのホスト名です (例: `pds.example.com`)。

これを行わないと Bluesky の AppView にアカウントが認識されず、`app.bsky.*` 系の操作が失敗します。

## 補足

- 初回リクエスト時に GitHub リポジトリが空であれば、自動的にリポジトリが初期化されます。
- すべてのブロックは GitHub リポジトリの `blocks/` 以下にファイルとして保存され、現在のルート CID は `refs/root` に記録されます。
- セッション作成 (`com.atproto.server.createSession`) の際、識別子にはハンドル、パスワードには `ADMIN_PASSWORD` を使用します。
