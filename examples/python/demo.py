"""Walk through the public Prokura demo over MCP (Streamable HTTP).

    python demo.py            catalog -> quote -> check without a mandate -> request a mandate
    python demo.py --wait     ...then wait for a human to open the grant URL and ask the gate
    python demo.py --no-mandate   skip the grant request (rate-limited: 5 per hour per address)

Demo only: fake store, fake money, Mollie test mode. prokura_check never pays.
Override the endpoint with PROKURA_MCP_URL.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from mcp import ClientSession

try:  # mcp >= 1.24 / 2.x
    from mcp.client.streamable_http import streamable_http_client as _http_client
except ImportError:  # older mcp 1.x
    from mcp.client.streamable_http import streamablehttp_client as _http_client

URL = os.environ.get("PROKURA_MCP_URL", "https://prokura.network/mcp")
WAIT = "--wait" in sys.argv
NO_MANDATE = "--no-mandate" in sys.argv


async def call(session: ClientSession, name: str, args: dict | None = None):
    res = await session.call_tool(name, args or {})
    data = getattr(res, "structured_content", None) or getattr(res, "structuredContent", None)
    if data is None:
        text = next((c.text for c in res.content if getattr(c, "type", "") == "text"), "")
        try:
            data = json.loads(text)
        except ValueError:
            data = text
    is_error = bool(getattr(res, "is_error", None) or getattr(res, "isError", None))
    return (not is_error), data


def show(label: str, ok: bool, data) -> None:
    print(f"\n# {label} {'' if ok else '(isError)'}\n{json.dumps(data, indent=2)}")


async def run(session: ClientSession) -> None:
    init = await session.initialize()
    info = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
    print(f"connected to {URL}: {info.name} {info.version}")
    tools = await session.list_tools()
    print("tools:", ", ".join(t.name for t in tools.tools))

    ok, catalog = await call(session, "store_catalog")
    show("store_catalog", ok, catalog)
    sku = (catalog.get("items") or [{}])[0].get("sku", "field-notebook")

    ok, quote = await call(session, "store_quote", {"sku": sku, "quantity": 1})
    show(f"store_quote {sku}", ok, quote)
    intent = {
        "amount": quote.get("amount", "12.00"),
        "currency": quote.get("currency", "EUR"),
        "payee": quote.get("payee", {"type": "domain", "value": "demo-store.prokura.network"}),
        "purpose": quote.get("purpose", "software"),
        "rail": quote.get("rail", "mollie"),
        "reference": {"item": sku},
        "agent_name": "prokura-verify (python)",
    }

    # Without a granted mandate the server refuses to call the gate. It will not invent a decision.
    show("prokura_check before any grant", *await call(session, "prokura_check", intent))
    if NO_MANDATE:
        return

    ok, grant = await call(session, "prokura_request_mandate")
    grant = {k: ("(QR code omitted)" if isinstance(v, str) and v.startswith(("<svg", "data:image")) else v)
             for k, v in (grant if isinstance(grant, dict) else {"response": grant}).items()}
    show("prokura_request_mandate", ok, grant)
    if not WAIT:
        print("\nThe grant is bound to this MCP session, which ends now. "
              "Run `python demo.py --wait` to request a grant and keep the session open while a human opens the URL.")
        return

    print("\nwaiting for a human to open the grant URL (up to 10 minutes)...")
    deadline = time.time() + 600
    ok, mandate = False, None
    while time.time() < deadline:
        ok, mandate = await call(session, "prokura_mandate")
        if ok:
            break
        await asyncio.sleep(5)
    if not ok:
        print("no grant within 10 minutes")
        return
    show("prokura_mandate", ok, mandate)
    show("prokura_check (quoted item)", *await call(session, "prokura_check", intent))
    show("prokura_check (80.00 EUR, above step-up)", *await call(session, "prokura_check", {**intent, "amount": "80.00"}))
    show("prokura_check (payee outside the mandate)",
         *await call(session, "prokura_check", {**intent, "payee": {"type": "domain", "value": "example.com"}}))


async def main() -> None:
    async with _http_client(URL) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as session:
            await run(session)


if __name__ == "__main__":
    asyncio.run(main())
