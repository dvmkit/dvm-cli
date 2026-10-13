import type { JobEnvelope } from "@dvmkit/sdk/internal";

export function buildJobEnvelope(opts: {
  /**
   * Capability name to dispatch on at the provider. Callers that
   * resolved the canonical slash form (`cast/add-episode`) pass the right
   * half here; the CLI auto-fills it for single-capability DVMs.
   */
  capability?: string;
  input: string;
  params?: string[];
  data?: Record<string, unknown>;
  outputType?: string;
  bidMsats?: number;
}): JobEnvelope {
  const envelope: JobEnvelope = {
    input: opts.input,
  };

  if (opts.capability !== undefined) {
    envelope.capability = opts.capability;
  }

  if (opts.params && opts.params.length > 0) {
    envelope.params = opts.params.map((p) => {
      const eq = p.indexOf("=");
      if (eq === -1) return [p, ""] as [string, string];
      return [p.slice(0, eq), p.slice(eq + 1)] as [string, string];
    });
  }

  // Caller-supplied `data` (e.g. `dvm quote --data '<json>'`) wins. Otherwise
  // synthesise `data` from `--param k=v` pairs so structured-input DVMs see
  // the agent-friendly form on the wire.
  if (opts.data) {
    envelope.data = opts.data;
  } else if (opts.params && opts.params.length > 0) {
    envelope.data = paramsToData(opts.params);
  }

  if (opts.outputType) {
    envelope.outputType = opts.outputType;
  }

  if (opts.bidMsats !== undefined) {
    envelope.bidMsats = opts.bidMsats;
  }

  return envelope;
}

/**
 * Serialise a {@link JobEnvelope} to the `POST /v1/job` wire body.
 *
 * Lives here rather than in the HTTPS transport because the agent wallet
 * persists this exact object onto a `pending_submission`: a resume
 * has to re-POST the body the original submit sent, byte-for-byte, or the DVM
 * rejects it at input validation before the payment is ever looked at.
 */
export function envelopeToPayload(job: JobEnvelope): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    input: job.input,
  };
  // include `capability` on the wire body when the caller knows it.
  // The CLI fills this in for the slash form and the bare-DVM single-capability
  // shortcut; legacy callers leave it off and the SDK rejects with
  // a structured `capability_required` envelope.
  if (job.capability !== undefined) payload.capability = job.capability;
  if (job.params) payload.params = Object.fromEntries(job.params);
  if (job.data) payload.data = job.data;
  if (job.outputType) payload.output_type = job.outputType;
  if (job.bidMsats !== undefined) payload.bid_msats = job.bidMsats;
  return payload;
}

/** Strict number-literal pattern. Excludes "01", "1.", ".5", "1e3", "NaN" so
 * leading-zero or non-canonical strings stay as strings. */
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function coerceScalar(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  if (NUMBER_RE.test(value)) return Number(value);
  return value;
}

/**
 * Build a structured `data` object from `--param k=v` strings.
 *
 * Coercion rules:
 * - `"true"` / `"false"` → boolean.
 * - Strict number literal → number.
 * - Repeated key → string/number/boolean array (each value coerced
 *   independently).
 * - Otherwise → string.
 *
 * Exported so callers can synthesise `data` up-front: schema-default
 * application and request signing must operate on the same object that ends up
 * on the wire, which means the params → data step has to happen before either.
 */
export function paramsToData(params: string[]): Record<string, unknown> {
  // Null-prototype object so `--param __proto__=…` (or any future coerced
  // object value) can't reach Object.prototype setters. `key in out` and
  // JSON.stringify both work correctly on null-prototype objects.
  const out = Object.create(null) as Record<string, unknown>;
  for (const raw of params) {
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const value = eq === -1 ? "" : raw.slice(eq + 1);
    const coerced = coerceScalar(value);
    if (key in out) {
      const existing = out[key];
      if (Array.isArray(existing)) {
        existing.push(coerced);
      } else {
        out[key] = [existing, coerced];
      }
    } else {
      out[key] = coerced;
    }
  }
  return out;
}
