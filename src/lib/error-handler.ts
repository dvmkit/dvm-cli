import {
  asProviderText,
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "./output";

import { takeCreditNoticeFields } from "./credit-notice";
import { takeFeedbackNoticeFields } from "./feedback-notice";

/**
 * Catch errors from a command action and exit the process when the command
 * finishes.
 *
 * The explicit `process.exit` is here because NWC keeps persistent websocket
 * connections to its relays that prevent Node's event loop from draining —
 * without an explicit exit the CLI would print its output and then hang
 * indefinitely. The OS reaps the open sockets and any pending timers for us on
 * exit, while an exit code already selected by the command is preserved.
 *
 * Commander awaits the returned promise through `parseAsync`. The small
 * referenced interval is intentional: an action can cross an async boundary
 * whose only handle has been unref'd (for example a lazy transport import),
 * and Node otherwise exits before the promise resolves. It is removed before
 * the explicit terminal exit, so it cannot keep an otherwise completed CLI
 * alive.
 */
export async function catchErrors(fn: () => void | Promise<void>, human?: boolean): Promise<void> {
  const lifetimeHold = setInterval(() => undefined, 60 * 60 * 1000);
  try {
    await fn();
  } catch (err) {
    handleError(err, human);
  } finally {
    clearInterval(lifetimeHold);
  }
  process.exit(process.exitCode ?? 0);
}

/**
 * Format an error and exit. Used by the CLI error boundary.
 *
 * A thrown error is a terminal like any other, so it drains the credit-notice
 * sink too — a credit left undrawn is what explains why the job was priced
 * per-call, and it matters most on the throws that follow a skipped draw
 * (`payment_insufficient`, `timeout`, a failed wallet spend). Draining here
 * rather than at each `throw` reaches every error terminal in every CLI at
 * once, and puts the fields at top level beside `error` — where the eleven
 * non-error terminals already put them — instead of nested inside it, which is
 * where a per-throw spread into `DvmError.data` would land them.
 *
 * The feedback-notice sink drains here for the same reason: the
 * sync failed arc reports the failure by throwing, so the `job_failed` error
 * payload is the terminal emission its nudge has to ride. Nothing stashes a
 * nudge outside a job-terminal moment, so on every other error both spreads
 * are empty.
 *
 * Human mode doesn't drain: the prose already went to stderr when the notice
 * was stashed.
 */
export function handleError(err: unknown, human?: boolean): never {
  if (err instanceof DvmError) {
    if (human) {
      if (err.code === "client_upgrade_required") {
        info([`Error: ${err.message}`, err.hint].filter(Boolean).join("\n"));
        process.exit(1);
      }
      // JSON spreads `data` last, so its relay fields are authoritative when
      // an error also uses the older positional `display`. Resolve human mode
      // the same way, including the human-directed next step carried only in
      // `data`, so the two renderings cannot drift .
      const dataDisplay = err.data?.display;
      const display = typeof dataDisplay === "string" ? dataDisplay : err.display;
      const dataNextStep = err.data?.next_step;
      const nextStep = typeof dataNextStep === "string" ? dataNextStep : undefined;
      const capabilities = Array.isArray(err.data?.available_capabilities)
        ? `Available capabilities: ${err.data.available_capabilities.join(", ")}` : undefined;
      info([`Error: ${err.message}`, display, capabilities, nextStep, err.hint].filter(Boolean).join("\n"));
    } else {
      const error: Record<string, unknown> = {
        code: err.code,
        message: err.message,
        ...(err.display ? { display: err.display } : {}),
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.data ?? {}),
      };
      for (const field of ["message", "display", "hint"] as const) {
        const value = error[field];
        if (err.proseSources?.[field] === "provider" && typeof value === "string") {
          error[field] = asProviderText(value);
        }
      }
      json({
        error,
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
      });
    }
    process.exit(1);
  }

  // Unknown errors may come from any dependency. Their messages are unbounded
  // third-party content, so publish only a bounded class/code fingerprint.
  const diagnostic = unknownErrorDiagnostic(err);
  const message = `An unexpected internal error occurred (${diagnostic.label}).`;
  if (human) {
    info(`Error: ${message}`);
  } else {
    json({
      error: {
        code: "internal",
        message,
        error_name: diagnostic.name,
        ...(diagnostic.code ? { error_code: diagnostic.code } : {}),
      },
      ...takeCreditNoticeFields(),
      ...takeFeedbackNoticeFields(),
    });
  }
  process.exit(1);
}

/**
 * Bounded fingerprint of an error from any dependency: a class name and an
 * errno-shaped `code`, both pattern-gated, never the unbounded message. The
 * generic `internal` terminal publishes it, and so does any error that wraps a
 * third-party failure in a DvmError, so a report never loses what failed.
 */
export function unknownErrorDiagnostic(err: unknown): {
  name: string;
  code?: string;
  label: string;
} {
  const name = unknownErrorName(err);
  const code = unknownErrorCode(err);
  return { name, ...(code ? { code } : {}), label: code ? `${name}:${code}` : name };
}

const ERROR_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A dependency's own `name` wins over its constructor name: a published bundle
 * minifies the constructor to a letter or two, while a library that sets
 * `this.name` keeps the class readable through the build.
 */
function unknownErrorName(err: unknown): string {
  if (!(err instanceof Error)) return `thrown_${typeof err}`;
  try {
    const own = err.name;
    if (typeof own === "string" && own !== "Error" && ERROR_NAME_PATTERN.test(own)) return own;
    const prototype = Object.getPrototypeOf(err) as { constructor?: unknown } | null;
    const constructor = prototype?.constructor;
    const name = typeof constructor === "function" ? constructor.name : "";
    return ERROR_NAME_PATTERN.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function unknownErrorCode(err: unknown): string | undefined {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) return undefined;
  try {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
