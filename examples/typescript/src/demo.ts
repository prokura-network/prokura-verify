/**
 * Walk through the public Prokura demo over MCP (Streamable HTTP).
 *
 *   npm run demo          catalog -> quote -> check without a mandate -> request a mandate
 *   npm run demo:wait     ...then wait for a human to open the grant URL and ask the gate
 *
 * Demo only: fake store, fake money, Mollie test mode. prokura_check never pays.
 * Endpoint can be overridden with PROKURA_MCP_URL.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.PROKURA_MCP_URL ?? "https://prokura.network/mcp";
const WAIT = process.argv.includes("--wait");
const NO_MANDATE = process.argv.includes("--no-mandate"); // grant requests are rate-limited (5 per hour per address)

type Out = { ok: boolean; data: any };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const res: any = await client.callTool({ name, arguments: args });
  let data = res.structuredContent;
  if (data === undefined) {
    const text = (res.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: !res.isError, data };
}

const show = (label: string, o: Out) => console.log(`\n# ${label} ${o.ok ? "" : "(isError)"}\n${JSON.stringify(o.data, null, 2)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new Client({ name: "prokura-verify-ts", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  console.log(`connected to ${URL_}: ${JSON.stringify(client.getServerVersion())}`);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

  const catalog = await call(client, "store_catalog");
  show("store_catalog", catalog);
  const sku = catalog.data?.items?.[0]?.sku ?? "field-notebook";

  const quote = await call(client, "store_quote", { sku, quantity: 1 });
  show(`store_quote ${sku}`, quote);
  const q = quote.data?.quote ?? quote.data ?? {};
  const intent = {
    amount: q.amount ?? "12.00",
    currency: q.currency ?? "EUR",
    payee: q.payee ?? { type: "domain", value: "demo-store.prokura.network" },
    purpose: q.purpose ?? "software",
    rail: q.rail ?? "mollie",
    reference: { item: sku },
    agent_name: "prokura-verify (typescript)",
  };

  // Without a granted mandate the server refuses to call the gate. It will not invent a decision.
  show("prokura_check before any grant", await call(client, "prokura_check", intent));

  if (NO_MANDATE) return client.close();

  const grant = await call(client, "prokura_request_mandate");
  const g = { ...grant.data };
  for (const k of Object.keys(g)) if (typeof g[k] === "string" && /^(<svg|data:image)/.test(g[k])) g[k] = "(QR code omitted)";
  show("prokura_request_mandate", { ...grant, data: g });

  if (!WAIT) {
    console.log("\nThe grant is bound to this MCP session, which ends now. Run `npm run demo:wait` to request a grant and keep the session open while a human opens the URL.");
    return client.close();
  }

  console.log("\nwaiting for a human to open the grant URL (up to 10 minutes)…");
  const deadline = Date.now() + 10 * 60_000;
  let mandate: Out | undefined;
  while (Date.now() < deadline) {
    mandate = await call(client, "prokura_mandate");
    if (mandate.ok) break;
    await sleep(5000);
  }
  if (!mandate?.ok) {
    console.log("no grant within 10 minutes");
    return client.close();
  }
  show("prokura_mandate", mandate);

  // Three checks: inside the mandate, above the step-up threshold, and to a payee outside it.
  show("prokura_check (quoted item)", await call(client, "prokura_check", intent));
  show("prokura_check (80.00 EUR, above step-up)", await call(client, "prokura_check", { ...intent, amount: "80.00" }));
  show("prokura_check (payee outside the mandate)", await call(client, "prokura_check", { ...intent, payee: { type: "domain", value: "example.com" } }));
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
