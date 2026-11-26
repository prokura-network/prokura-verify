import type { ProkuraMcp, ToolResult } from "../src/index.ts";

export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const EVIDENCE = "01JZX4PROKURATESTRECEIPT00";

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** A Prokura MCP stand-in: answers each tool call with `answer(call)`. */
export function mockMcp(answer: (call: Call) => ToolResult | Promise<ToolResult>) {
  const calls: Call[] = [];
  const mcp: ProkuraMcp = {
    async callTool(name, args) {
      const call = { name, args };
      calls.push(call);
      return answer(call);
    },
  };
  return { mcp, calls };
}

export const ok = (body: Record<string, unknown>): ToolResult => ({
  structuredContent: body,
  content: [{ type: "text", text: JSON.stringify(body) }],
});
export const refused = (body: Record<string, unknown>): ToolResult => ({
  isError: true,
  structuredContent: body,
  content: [{ type: "text", text: JSON.stringify(body) }],
});

/** A v2 challenge as @x402/core servers send it (PAYMENT-REQUIRED header). */
export function challengeV2(url: string, amount: string, asset = USDC_BASE_SEPOLIA) {
  return {
    x402Version: 2,
    error: "payment required",
    resource: { url, description: "Weather forecast", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset,
        amount,
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

/**
 * A mocked x402 resource server as a fetch function: 402 with the challenge
 * until a PAYMENT-SIGNATURE (or X-PAYMENT) header arrives, then 200.
 */
export function mock402Server(challenge: (url: string) => unknown, opts: { header?: boolean } = {}) {
  const seen: { url: string; paid: boolean }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const paid = req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("X-PAYMENT");
    seen.push({ url: req.url, paid });
    if (new URL(req.url).pathname === "/free") return Response.json({ free: true });
    if (paid) return Response.json({ forecast: "sunny" }, { headers: { "PAYMENT-RESPONSE": "" } });
    const body = challenge(req.url);
    if (opts.header === false) return Response.json(body, { status: 402 });
    return new Response("{}", {
      status: 402,
      headers: {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64"),
      },
    });
  };
  return { fetch, seen };
}
