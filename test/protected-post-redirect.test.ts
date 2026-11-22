import { signDvmRequestData, type JobEnvelope } from "@dvmkit/sdk/internal";
import { expect, it, vi } from "vitest";
import { HttpsTransport } from "../src/lib/transport/https";

const source = { endpoint: "https://approved.example" };
const other = "https://redirect.example";
const payment = { cashuToken: "test-payment", cashuRequestId: "test-payment-id" };
const job: JobEnvelope = {
  input: "work",
  data: signDvmRequestData("01".repeat(32), { mandate: { max_total_micro: 100_000, max_ask_micro: 50_000 } },
    { audience: { dvm_id: "fixture", builder_pubkey: "ab".repeat(32) }, method: "POST", path: "/v1/job", capability: "run" }),
};

it.each([
  ["a mandate submission", (transport: HttpsTransport) => transport.submit(source, job)],
  ["a paid submission", (transport: HttpsTransport) => transport.submit(source, { input: "work" }, payment)],
  ["a mandate quote", (transport: HttpsTransport) => transport.quote(source, job)],
  ["a balance payment", (transport: HttpsTransport) => transport.sendMessage("job", { type: "payment", content: {} }, source)],
  ["paid credit funding", (transport: HttpsTransport) => transport.credit(source, { op: "fund" }, payment)],
  ["request-result", (transport: HttpsTransport) => transport.requestResult(source, "request-id", job)],
  ["request-resume", (transport: HttpsTransport) => transport.requestResume(source, "request-id", job)],
] as const)("holds %s at its original origin", async (_kind, send) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
    status: 307, headers: { Location: other + "/relocated" },
  }));
  const transport = new HttpsTransport();
  await expect(send(transport)).rejects.toMatchObject({
    code: "protected_post_redirect",
    data: { from_origin: source.endpoint, to_origin: other },
    display: expect.stringContaining(source.endpoint + " to " + other),
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "manual" });
});

it("keeps the protected body and credentials on a same-origin 308", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Location: "/new-job" } }))
    .mockResolvedValueOnce(Response.json({ job_id: "job", status: "processing" }));
  const transport = new HttpsTransport();
  await expect(transport.submit(source, job, payment)).resolves.toMatchObject({ jobId: "job" });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([source.endpoint + "/v1/job", source.endpoint + "/new-job"]);
  const [first, second] = fetch.mock.calls.map(([, init]) => init);
  expect(second?.body).toEqual(first?.body);
  expect(new Headers(second?.headers).get("x-cashu")).toBe(payment.cashuToken);
});
