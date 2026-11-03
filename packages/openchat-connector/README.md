# OpenChat connector

L Harness Cloud / OSS共通の個人LINE接続サービス。Cloud管理の場合は認証情報を暗号化した永続ストレージに、OSS端末接続の場合は端末内に保存します。選択した部屋の履歴と送信キューはHarness側に置きます。

詳しい導入・障害対応は [接続ガイド](../../docs/openchat-connector.md) を参照してください。

```sh
node connector.mjs --config /private/path/openchat-connector.json
# OSS単独でQR認証する場合
node login.mjs --config /private/path/openchat-connector.json
```

本パッケージは開発中のbetaで、npmには公開していません。リポジトリから実行します。Cloud管理サービスは `apps/openchat-manager`、その常駐ランタイムは `managed/server.mjs` です。配信・実アカウント認証はまだ別途必要です。

ランタイムの再現ビルド:

```sh
python3 scripts/fetch-runtime-source.py /private/path/source-vfs.json
node scripts/build-runtime.cjs /private/path/source-vfs.json
```

認証情報・接続キー・送信履歴はソース管理へ追加しないでください。
