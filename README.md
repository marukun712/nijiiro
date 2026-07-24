# nijiiro

nijiiroは、単一サーバーで完結する、シンプルなATProtocol PDSです。

> [!WARNING]
> このリポジトリは、個人の実験プロジェクトです。セキュリティ的な監査は受けていませんので、自己責任での利用をお願いします。

## セットアップ

### 1. 秘密鍵とパスワードの生成

鍵ペアとパスワードを生成します。

```sh
deno task setup

REPO_SIGNING_KEY=<hex>
ADMIN_PASSWORD=<base64>
REPO_SIGNING_KEY_DID=did:key:z...
```

また、対話型で Bluesky でのハンドルネームを設定します。

### 2. config.ts の編集

```sh
cp config.example.ts config.ts
```

configを編集します。

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

```sh
cp .env.example .env
```

先ほど生成したシークレットを入れます。

```env
REPO_DID=
REPO_HANDLE=
REPO_SIGNING_KEY=

ADMIN_PASSWORD=
PDS_URL=
PORT=
```

### 4. リポジトリのビルド

レコードからMSTをビルドします。

```sh
deno task build
```

### 5. サーバーの起動

```sh
deno task start
```

DIDドキュメントが配信されているかの確認

```sh
curl https://<your-domain>/.well-known/did.json
```

## リレーへの登録

Bluesky のリレーにクロールをリクエストして AppView にインデックスされるようにします。

```sh
curl -X POST https://bsky.network/xrpc/com.atproto.sync.requestCrawl \
  -H "Content-Type: application/json" \
  -d '{"hostname": "<your-pds-hostname>"}'
```

`<your-pds-hostname>` はスキームなしのホスト名です (例: `pds.example.com`)。
