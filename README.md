# prokura-verify

Examples and an offline verifier for Prokura Nachweis receipts — the power of attorney for machines.

**Prokura is the power of attorney for machines**: a signed record of which agent may spend for whom, checked before every payment and provable afterwards.

A human signs a mandate for an AI agent: cap, payees, purposes, expiry. Before any payment, a gate with no AI in it checks the mandate and answers **allow**, **step-up** (a human approves) or **deny**, with reason codes. Every decision becomes a signed, hash-chained record, a **Nachweis**, that anyone can verify offline. The network moves the money. Prokura proves the authority behind it.

What Prokura is not, in its own words: no custody of funds, no payment guarantees, no identity or KYC, no LLM in the decision path, no consumer app.

This repository has:

| Path | What |
|---|---|
| [`examples/`](examples) | TypeScript and Python scripts that drive the public demo over MCP |
| [`verifier/`](verifier) | Offline Nachweis verifiers in TypeScript and Python, tested against real demo files |
| [`docs/reason-codes.md`](docs/reason-codes.md) | The closed reason-code list and the decision rule |
| [`docs/nachweis-format.md`](docs/nachweis-format.md) | Every verification rule, its source, and open spec questions |
| [`integrations/`](integrations) | **Sketches** for coinbase/agentkit, Google AP2 and x402 |
| [`config/`](config) | Ready MCP client configs |
| [`server.json`](server.json) | Official MCP Registry entry |

Everything here describes Prokura in terms [prokura.network](https://prokura.network) uses. For anything not covered, [llms.txt](https://prokura.network/llms.txt) is the source of truth.

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
3. Until that grant is done, `prokura_check`, `prokura_pay`, `prokura_evidence` and `prokura_mandate` answer `grant_required` / `grant_pending`. The server will not invent an allow, a step-up or a deny.
4. After the grant: `prokura_check` asks the gate (nothing is paid). `prokura_pay` submits an intent, and only an allow is executed. `prokura_evidence` fetches the Nachweis.

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

The same command verifies a signed daily root: `curl -s https://api.prokura.network/v1/roots/2026-11-25 > root.json && prokura-verify root.json`.

**Pin the server key.** A Nachweis names its own signing key. Get the key from a signed daily root (`GET https://api.prokura.network/v1/roots/{date}`, field `server`) and pass it with `--server-key`; otherwise the verifier warns that the key is self-asserted.

**What's spec and what's observed.** The hash, chain, genesis and Ed25519-over-raw-hash rules come straight from llms.txt. Some details aren't written down on the site: the exact list of "remaining stored fields", the base64url signature encoding, `intentHash`, the agent's intent signature, the export proof and the root signature. For those, the verifiers follow the homepage's in-browser verifier and real demo files, and they are labelled **OBSERVED** in [`docs/nachweis-format.md`](docs/nachweis-format.md). Merkle inclusion proofs aren't verified because the leaf and tree format aren't specified. That doc lists the open questions.

## Tests

```bash
cd verifier/typescript && npm test      # 14 tests
cd verifier/python && pytest            # 13 tests
```

Both suites run against three real demo exports (allow, step-up, deny), one real signed daily root, a synthetic chain from genesis (v1 and v2 records, throwaway key), shared RFC 8785 vectors, and tampering cases (amount, decision, re-hash without signing, removed record, wrong key, edited export, edited root).

## License, contributing, security

Apache-2.0 ([LICENSE](LICENSE)). See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities to **hello@prokura.network** ([SECURITY.md](SECURITY.md)).
