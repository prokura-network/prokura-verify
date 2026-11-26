# Examples

Both scripts do the same thing against `https://prokura.network/mcp` (override with `PROKURA_MCP_URL`):

1. `store_catalog`, then `store_quote` for the first item
2. `prokura_check` **before** any grant, which returns `grant_required` (the server won't invent a decision)
3. `prokura_request_mandate`, which prints the grant URL (the QR code is left out of the output)
4. with `--wait`: polls `prokura_mandate` until a human has opened the URL, then runs three checks: the quoted item, 80.00 EUR (above the 50.00 EUR step-up) and a payee outside the mandate

`--no-mandate` stops after step 2. Grant requests are limited to 5 per address per hour.

- TypeScript: `cd typescript && npm install && npm run demo` (uses `@modelcontextprotocol/sdk`)
- Python: `cd python && pip install -r requirements.txt && python demo.py` (uses the `mcp` SDK, Python 3.10+)
