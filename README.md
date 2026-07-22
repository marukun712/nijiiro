# nijiiro

nijiiroは、シンプルなATProtocol PDSです。

> [!WARNING]
> このリポジトリは、個人の実験プロジェクトです。セキュリティ的な監査は受けていませんので、自己責任での利用をお願いします。

## 前提条件

- HTTPS に対応した管理下のドメイン (例: `example.com`)
- Deno がインストールされていること

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

対話型で簡易的にBlueskyプロフィールを設定することができます。

### 2. config.ts の編集

`config.example.ts` を `config.ts` にコピーして編集します:

```sh
cp config.example.ts config.ts
```

`config.ts` 内の DID ドキュメントを編集してください。以下のプレースホルダーを置き換えます:

- `did:web:localhost` → `did:web:<your-domain>` (例: `did:web:example.com`)
- `at://localhost.local` → `at://<your-handle>` (例: `at://example.com`)
- `publicKeyMultibase` → ステップ 1 で出力された `REPO_SIGNING_KEY_DID` の値 (`did:key:` プレフィックスを含む全体)
- `serviceEndpoint` → このサーバーの公開 URL (例: `https://pds.example.com`)
- `defaultPath` → レコードを保存するディレクトリのパス

```ts
const config: Config = {
  defaultPath: "./records",
  collections: {},
  didDoc: {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      "https://w3id.org/security/suites/secp256k1-2019/v1",
    ],
    id: "did:web:<your-domain>",
    alsoKnownAs: ["at://<your-handle>"],
    verificationMethod: [
      {
        id: "did:web:<your-domain>#atproto",
        type: "Multikey",
        controller: "did:web:<your-domain>",
        publicKeyMultibase: "<REPO_SIGNING_KEY_DID>",
      },
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: "<your-pds-url>",
      },
    ],
  },
};
```

### 3. 環境変数の設定

`.env.example` を `.env` にコピーして、各値を埋めます:

```sh
cp .env.example .env
```

```env
REPO_DID=did:web:<your-domain>
REPO_HANDLE=<your-handle>
REPO_SIGNING_KEY=<ステップ 1 の値>

JWT_SECRET=<ステップ 1 の値>
ADMIN_PASSWORD=<ステップ 1 の値>
```

`PORT` は省略可能で、デフォルトは `8080` です。

### 4. リポジトリのビルド

レコードからMSTをビルドします:

```sh
deno task build
```

### 5. サーバーの起動

```sh
deno task start
```

サーバー起動後、DID ドキュメントが配信されているか確認できます:

```sh
curl https://<your-domain>/.well-known/did.json
```

## リレーへの登録

セットアップ完了後、Bluesky のリレーにクロールをリクエストして AppView にインデックスされるようにします。

```sh
curl -X POST https://bsky.network/xrpc/com.atproto.sync.requestCrawl \
  -H "Content-Type: application/json" \
  -d '{"hostname": "<your-pds-hostname>"}'
```

`<your-pds-hostname>` はスキームなしのホスト名です (例: `pds.example.com`)。

これを行わないと Bluesky の AppView にアカウントが認識されず、`app.bsky.*` 系の操作が失敗します。

## 実装予定

- Bluesky AppView 以外の対応
- OAuth
