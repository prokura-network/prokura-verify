# prokura-verify

The open specification of the Prokura Nachweis, offline verifiers for it, and examples that drive our public demo over MCP.

**Prokura is the power of attorney for machines**: a signed record of which agent may spend for whom, checked before every payment and provable afterwards.

A human signs a mandate for an AI agent: cap, payees, purposes, expiry. Before any payment, our gate, which has no AI in it, checks the mandate and answers **allow**, **step-up** (a human approves) or **deny**, with reason codes. Every decision becomes a signed, hash-chained record, a **Nachweis**, that anyone can verify offline. The payment network moves the money. Prokura proves the authority behind it.

What Prokura is not: we hold no funds, give no payment guarantees, do no identity checks or KYC, have no LLM in the decision path, and make no consumer app.

This repository is the part you can check without trusting us. The gate and the core service are not in it.

| Path | What |
|---|---|
| [`docs/nachweis-format.md`](docs/nachweis-format.md) | The Nachweis specification: records, hashes, signatures, keys, Merkle trees and proofs |
| [`docs/reason-codes.md`](docs/reason-codes.md) | The closed list of reason codes and the decision rule |
| [`docs/tool-annotations.md`](docs/tool-annotations.md) | What each MCP tool does, and its annotations |
| [`verifier/`](verifier) | Offline verifiers in Python and TypeScript, tested against real demo exports and a real signed root |
| [`examples/`](examples) | TypeScript and Python scripts that drive the public demo over MCP |
| [`integrations/`](integrations) | Where Prokura fits with x402, coinbase/agentkit and Google AP2 |
| [`config/`](config) | Ready MCP client configs |
| [`server.json`](server.json) | Our entry in the official MCP Registry |

## Try the demo in your MCP client

Endpoint: `https://prokura.network/mcp` (Streamable HTTP, no auth)

The demo is session-bound: ten minutes, 100.00 EUR per payment, step-up above 50.00 EUR, 150.00 EUR per day, fake money, the fake store only, Mollie test mode. Five grant requests per client address per hour, one active grant per MCP session.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`), and most clients that take a URL:

```json
{"mcpServers":{"prokura":{"url":"https://prokura.network/mcp"}}}
```

**Claude Desktop / claude.ai** (plans with custom connectors): Settings → Connectors → *Add custom connector*, URL `https://prokura.network/mcp`. If your Claude Desktop only reads `claude_desktop_config.json`, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) ([`config/claude_desktop_config.json`](config/claude_desktop_config.json)):

```json
{"mcpServers":{"prokura":{"command":"npx","args":["-y","mcp-remote","https://prokura.network/mcp"]}}}
```

**Claude Code**: `claude mcp add --transport http prokura https://prokura.network/mcp`

**VS Code** (`.vscode/mcp.json`): see [`config/vscode-mcp.json`](config/vscode-mcp.json).

Then ask your agent something like: *"Look at the Prokura demo store, get a quote for the field notebook, and request a mandate."* Open the grant URL it returns. **You** are the human who grants it, and only then will the gate answer.

### How the demo flow works

1. `store_catalog` / `store_quote`: the fake store. A quote is not a decision.
2. `prokura_request_mandate`: returns a grant URL on `approve.prokura.network` and a QR code. It **never** returns a mandate, and any scope, principal or amount you send is ignored. Authority comes from the human who opens the URL.
3. Until that grant is done, `prokura_check`, `prokura_pay`, `prokura_evidence` and `prokura_mandate` answer `grant_required` / `grant_pending` and the gate is not called: there is no allow, step-up or deny without a human-granted mandate.
4. After the grant: `prokura_check` asks the gate (nothing is paid). `prokura_pay` submits an intent, and only an allow is executed. `prokura_evidence` fetches the signed evidence records.

## Run the examples

```bash
# TypeScript (Node 20+)
cd examples/typescript && npm install
npm run demo          # catalog, quote, check without a mandate, request a mandate
npm run demo:wait     # same, then waits for you to open the grant URL and runs three checks

# Python (3.10+)
cd examples/python && pip install -r requirements.txt
python demo.py        # or: python demo.py --wait
```

Add `--no-mandate` to skip the grant request (they're rate-limited). The grant belongs to the MCP session, so use `--wait` if you want to grant it and see the gate's decision in the same run.

## Verify a Nachweis offline

Download a Nachweis after a run on [prokura.network](https://prokura.network) ("download nachweis (json)"), then:

```bash
# Python (only needs `cryptography`)
cd verifier/python && pip install -e .
prokura-verify nachweis.json --server-key did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L

# TypeScript
cd verifier/typescript && npm install
npm run verify -- nachweis.json --server-key did:key:z6MksY9Gi8N1cbigCxWyR53eLdiTUUTaxq2A1c6mZe5Lea4L
```

```text
01M8C9B5F57A16FPSDZP8G8M31  pay       allow    hash=OK link=OK mandateLink=OK signature=OK intentHash=OK agentSignature=OK agentIsCredentialSubject=OK
…
export proof: OK
VERIFIED
```

The same command verifies a signed daily root or hourly checkpoint: `curl -s https://api.prokura.network/v1/roots/2026-11-25 > root.json && prokura-verify root.json --server-key did:key:…`.

**Pin the server key.** A Nachweis names its own signing key, so verify against the key you got from us: `GET https://api.prokura.network/v1/public/keys` lists the current key (`evidence`) and every earlier one, and each signed daily root names it in `server`. Without `--server-key` the verifier warns that the key is self-asserted. After a key rotation, pass the ring comma-separated.

**Inclusion proofs.** A record's inclusion proof (`merkle-proof/v1` against the daily root, or `merkle-checkpoint-proof/v1` against the latest hourly checkpoint) verifies the same way: `prokura-verify proof.json --server-key did:key:… --record-hash <the record's hash>`.

Every rule the verifiers apply is in [`docs/nachweis-format.md`](docs/nachweis-format.md).

## Tests

```bash
cd verifier/typescript && npm test      # 20 tests
cd verifier/python && pytest            # 20 tests
```

Both suites run against three real demo exports (allow, step-up, deny), one real signed daily root, and synthetic fixtures made with throwaway keys by `verifier/typescript/scripts/make-vectors.ts`: a chain from genesis (v1 and v2 records), Merkle roots and audit paths for trees of 0 to 9 leaves, signed inclusion proofs against a daily root and an hourly checkpoint, a key rotation, and shared RFC 8785 vectors. `fixtures/ed25519-strict-vectors.json` is a fixed corpus (not generated by that script) for the signature acceptance rules in [`docs/nachweis-format.md`](docs/nachweis-format.md) §3.5: a valid signature, a non-canonical S, the identity-key zero-signature case, and the eight small-order points on edwards25519. Tampering cases cover amount, decision, re-hashing without signing, a removed record, a wrong or unpinned key, an edited export or root, edited proofs, a moved rotation window, and a non-canonical S on a real record.

## License, contributing, security

Apache-2.0 ([LICENSE](LICENSE)). See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities to **hello@prokura.network** ([SECURITY.md](SECURITY.md)).
