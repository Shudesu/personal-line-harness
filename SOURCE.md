# Source and attribution

The connection runtime, manager, encrypted state handling, conversation routes and database schema derive from the personal LINE implementation of LINE Harness by Shudesu (2026), under MIT. This independent project adds a dedicated MCP server, a standalone owner-authenticated API and a QR setup page. No private repository history or operational records are included.

LINEJS is pinned to commit `4fc512ab8c19a2490ca73bb71777beb775ca3ae3` at https://github.com/evex-dev/linejs. Preserve `vendor/LINEJS-LICENSE`, `vendor/THIRD-PARTY-NOTICES.txt`, `vendor/SOURCE.txt` and `vendor/WORKER-SOURCE.txt` together with the bundles. The Worker adaptation uses native fetch and invocation-local storage; authenticated state remains in encrypted Durable Object storage.

The internal `openchat_*` names are inherited storage/API names and distinguish individual/group conversations by kind; they do not imply that personal LINE identities are official-account friends.
