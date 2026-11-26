import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  fromMcpClient,
  ProkuraDeniedError,
  ProkuraGrantError,
  ProkuraStepUpError,
  ProkuraTransportError,
  prokuraPay,
  readToolResult,
  requestMandate,
} from "../src/index.ts";
import { EVIDENCE, mockMcp, ok, refused } from "./helpers.ts";

/** An in-process MCP server with the Prokura tool names, over the real SDK. */
async function sdkPair() {
  const server = new McpServer({ name: "prokura-mock", version: "0" });
  const seen: Record<string, unknown>[] = [];
  server.registerTool(
    "prokura_check",
    { inputSchema: { amount: z.string(), payee: z.object({ type: z.string(), value: z.string() }) }, outputSchema: {} },
    async (args) => {
      seen.push(args);
      const body = { decision: "deny", reasons: ["CAP_PER_TX_EXCEEDED"], evidenceId: EVIDENCE };
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
    },
  );
  server.registerTool("prokura_request_mandate", { inputSchema: { agent_name: z.string().optional() } }, async () => {
    const body = { status: "pending_human_grant", grantUrl: "https://approve.prokura.network/g/x", expiresAt: "2026-11-26T12:10:00Z" };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return { mcp: fromMcpClient(client), seen };
}

test("fromMcpClient talks to a real MCP server", async () => {
  const { mcp, seen } = await sdkPair();
  const body = readToolResult(await mcp.callTool("prokura_check", { amount: "1.00", payee: { type: "domain", value: "a.example.com" } }));
  assert.equal(body.decision, "deny");
  assert.equal(seen.length, 1);
  const grant = await requestMandate(mcp, "bot");
  assert.equal(grant.status, "pending_human_grant");
  assert.equal(grant.grantUrl, "https://approve.prokura.network/g/x");
  await mcp.close?.();
});

test("readToolResult: grant refusals, other errors, text-only answers", () => {
  assert.throws(() => readToolResult(refused({ error: "grant_required", message: "no mandate" })), ProkuraGrantError);
  assert.throws(
    () => readToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }),
    (e: unknown) => e instanceof ProkuraTransportError && /boom/.test(e.message),
  );
  assert.deepEqual(readToolResult({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.throws(() => readToolResult({ content: [] }), ProkuraTransportError);
});

test("prokuraPay allow: returns the paid response and the receipt", async () => {
  const { mcp, calls } = mockMcp(() =>
    ok({
      decision: "allow",
      reasons: [],
      evidenceId: EVIDENCE,
      execution: { rail: "x402", railStatus: "settled", railRef: "0xabc", response: { status: 200, contentType: "application/json", body: '{"forecast":"sunny"}' } },
    }),
  );
  const r = await prokuraPay("https://api.weather.example.com/forecast", { mcp, purpose: "api_usage", agentName: "bot" });
  assert.deepEqual(calls[0], {
    name: "prokura_pay",
    args: { x402Url: "https://api.weather.example.com/forecast", purpose: "api_usage", agent_name: "bot" },
  });
  assert.equal(r.receipt.evidenceId, EVIDENCE);
  assert.equal(r.execution?.response?.body, '{"forecast":"sunny"}');
});

test("prokuraPay step_up: approval URL, thrown or returned", async () => {
  const stepUp = { url: "https://approve.prokura.network/a/1", expiresAt: "2026-11-26T12:15:00Z" };
  const { mcp } = mockMcp(() => ok({ decision: "step_up", reasons: ["STEP_UP_REQUIRED"], evidenceId: EVIDENCE, stepUp }));
  await assert.rejects(prokuraPay("https://a.example.com/x", { mcp }), (e: unknown) => {
    assert.ok(e instanceof ProkuraStepUpError);
    assert.equal(e.approvalUrl, stepUp.url);
    return true;
  });
  const r = await prokuraPay("https://a.example.com/x", { mcp, onStepUp: "return" });
  assert.equal(r.approvalUrl, stepUp.url);
  assert.equal(r.receipt.decision, "step_up");
});

test("prokuraPay deny: throws with reasons and receipt", async () => {
  const { mcp } = mockMcp(() => ok({ decision: "deny", reasons: ["RAIL_NOT_ALLOWED"], evidenceId: EVIDENCE }));
  await assert.rejects(
    prokuraPay("https://a.example.com/x", { mcp }),
    (e: unknown) => e instanceof ProkuraDeniedError && e.code === "RAIL_NOT_ALLOWED" && e.evidenceId === EVIDENCE,
  );
});
