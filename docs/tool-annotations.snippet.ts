// Ready to paste into the MCP server (TypeScript SDK). Spread `annotations` into each
// tool definition in tools/list, e.g. server.registerTool(name, { title, description,
// inputSchema, annotations: ANNOTATIONS[name] }, handler), or add `annotations` to the
// objects you already return from tools/list. Keep the top-level `title` you have today.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Creates a pending grant on approve.prokura.network. Additive, nothing paid.
  // Every call makes a new grant URL (rate-limited, one active grant per session), so not idempotent.
  prokura_request_mandate: { title: "Request a demo mandate", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

  // "Nothing is paid." Asks the gate; no budget or payment state changes.
  // (It does append a check record to the evidence log; see note in tool-annotations.md.)
  prokura_check: { title: "Check a payment", readOnlyHint: true, openWorldHint: false },

  // Only an allow is executed, but an executed payment cannot be undone by calling again,
  // and a second call is a second payment. x402Url fetches an arbitrary external URL.
  prokura_pay: { title: "Pay", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

  prokura_evidence: { title: "Get evidence", readOnlyHint: true, openWorldHint: false },
  prokura_mandate: { title: "Get mandate", readOnlyHint: true, openWorldHint: false },
  store_catalog: { title: "Fake store catalog", readOnlyHint: true, openWorldHint: false },
  store_quote: { title: "Fake store quote", readOnlyHint: true, openWorldHint: false },
};
