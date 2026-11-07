import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpsTransport } from "../src/lib/transport/https";

afterEach(() => vi.unstubAllGlobals());

describe.each([400, 402])("nested HTTP %s submission errors", (status) => {
  it.each([
    { label: "outer payment uncertainty", outer: { payment_state: "unknown" }, nested: {}, expected: { payment_state: "unknown" } },
    { label: "outer status uncertainty", outer: { status: "unknown" }, nested: {}, expected: { status: "unknown" } },
    {
      label: "outer uncertainty despite nested refusal fields",
      outer: { status: "unknown", payment_state: "unknown" },
      nested: { status: "refused", payment_state: "unpaid" },
      expected: { status: "unknown", payment_state: "unknown" },
    },
    {
      label: "nested uncertainty despite outer refusal fields",
      outer: { status: "refused", payment_state: "unpaid" },
      nested: { status: "unknown", payment_state: "unknown" },
      expected: { status: "unknown", payment_state: "unknown" },
    },
  ])("preserves $label in the decoded error", async ({ outer, nested, expected }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...outer, error: { code: "invalid_input", message: "Invalid topic.", hint: "Supply a longer topic.", ...nested },
    }), { status, headers: { "Content-Type": "application/json" } })));

    await expect(new HttpsTransport().submit({ endpoint: "https://provider.invalid" }, {
      capability: "echo", input: "x",
    })).rejects.toMatchObject({
      code: "invalid_input", message: "Invalid topic.", hint: "Supply a longer topic.", data: expected,
    });
  });
});
