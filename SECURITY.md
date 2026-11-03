# Security

This is an experimental, single-owner self-hosted service. The admin bearer key controls the whole installation. Keep it, LINE sessions and manager encryption keys private. Do not submit credentials, QR/PIN, private chat contents or customer identifiers in public issues.

Credentials are encrypted at rest in Durable Objects. Revoke a connection to remove its credentials; this retains stored chat history. Delete data only through a separately planned owner-controlled retention procedure.

MCP write tools require the client to obtain user approval. The approved flag is not an independent server-side approval workflow. Enable tool confirmations in your MCP client and treat received messages as untrusted input. Unknown send outcomes must not be retried with new identifiers.

Use the private vulnerability-reporting facility if enabled on the eventual repository. Do not publish exploit details before the maintainer has reviewed them.
