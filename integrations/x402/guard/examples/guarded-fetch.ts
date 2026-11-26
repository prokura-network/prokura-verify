/**
 * Pay an x402 API only if Prokura allows it.
 *
 *   npm run example              live Prokura MCP (demo grant), local mock 402 API
 *   npm run example -- --wait    also wait until you approved the demo grant
 *   npm run example -- --offline mock Prokura too (no network at all)
 *
 * The wallet here is a stand-in that signs nothing real. In your agent you
 * register a real scheme instead, e.g. new ExactEvmScheme(signer) from @x402/evm.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  connectProkura,
  createProkuraGuard,
  ProkuraDeniedError,
  ProkuraGrantError,
  type ProkuraMcp,
  ProkuraStepUpError,
  requestMandate,
} from "../src/index.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia
const API = "https://api.weather.example.com/forecast?city=berlin";

/** A paid API that answers 402 (0.05 USDC) until it sees a payment header. */
async function paidApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  if (req.headers.has("PAYMENT-SIGNATURE")) return Response.json({ forecast: "sunny, 4 °C" });
  const challenge = {
    x402Version: 2,
    resource: { url: req.url, description: "Weather forecast" },
    accepts: [
      { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "50000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
    ],
  };
  return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64") } });
}

const offlineMcp: ProkuraMcp = {
  async callTool(name, args) {
    const body = { decision: "allow", reasons: [], evidenceId: "offline-example" };
    console.log(`[mock prokura] ${name}`, JSON.stringify(args));
    return { structuredContent: body };
  },
};

async function main() {
  const offline = process.argv.includes("--offline");
  const mcp = offline ? offlineMcp : await connectProkura();
  try {
    if (!offline) {
      let grant = await requestMandate(mcp, "x402-guard-example");
      if (grant.grantUrl) console.log(`Approve the demo mandate: ${grant.grantUrl}`);
      while (process.argv.includes("--wait") && grant.status !== "granted") {
        await sleep(3000);
        grant = await requestMandate(mcp, "x402-guard-example");
      }
    }

    const guard = createProkuraGuard({ mcp, agentName: "x402-guard-example" });
    const wallet = {
      scheme: "exact",
      findDefaultAsset: (asset: string) => (asset === USDC ? { asset, decimals: 6, symbol: "USDC" } : undefined),
      async createPaymentPayload(x402Version: number) {
        console.log("[wallet] signing (stand-in)");
        return { x402Version, payload: { signature: "0xexample" } };
      },
    };
    const client = guard.protect(new x402Client().register("eip155:84532", wallet));
    const fetchPaid = guard.wrapFetch(wrapFetchWithPayment(paidApi, client));

    const res = await fetchPaid(API);
    console.log("paid:", res.status, await res.text());
    console.log("Nachweis:", guard.receiptOf(res)?.evidenceId);
  } catch (err) {
    if (err instanceof ProkuraDeniedError) console.log(`denied: ${err.reasons.join(", ")} (Nachweis ${err.evidenceId})`);
    else if (err instanceof ProkuraStepUpError) console.log(`needs approval: ${err.approvalUrl ?? "(no link from prokura_check)"} (Nachweis ${err.evidenceId})`);
    else if (err instanceof ProkuraGrantError) console.log(`no mandate yet (${err.code}); run again with --wait and approve the link it prints`);
    else throw err;
  } finally {
    await mcp.close?.();
  }
}

await main();
