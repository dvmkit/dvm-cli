import { DvmError, providerProseSources } from "@dvmkit/sdk/internal";

import { CALLER_VERSION } from "./caller-version";

export const DVM_PROTOCOL_VERSION = "1";

export const CLIENT_COMPATIBILITY_HEADERS = {
  client: "DVM-Client",
  protocolVersion: "DVM-Protocol-Version",
  capabilities: "DVM-Client-Capabilities",
} as const;

export const DVM_CLIENT_CAPABILITIES = Object.freeze([
  "credit-recovery",
  "request-resume",
] as const);

export const DVM_CLIENT = `dvm/${CALLER_VERSION}`;

export interface ClientUpgradeRequired {
  readonly required_capabilities: readonly string[];
  readonly minimum_client_version?: string;
  readonly current_client_version?: string;
  readonly display: string;
  readonly hint: string;
}

export function dvmClientHeaders(): Readonly<Record<string, string>> {
  return {
    [CLIENT_COMPATIBILITY_HEADERS.client]: DVM_CLIENT,
    [CLIENT_COMPATIBILITY_HEADERS.protocolVersion]: DVM_PROTOCOL_VERSION,
    [CLIENT_COMPATIBILITY_HEADERS.capabilities]: DVM_CLIENT_CAPABILITIES.join(","),
  };
}

export function withDvmClientHeaders(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Parameters<typeof fetch>[1] {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(source);
  for (const [name, value] of Object.entries(dvmClientHeaders())) headers.set(name, value);
  return { ...init, headers };
}

export function parseClientUpgradeRequired(body: string): ClientUpgradeRequired | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.error !== "client_upgrade_required") return undefined;

  const required = value.required_capabilities;
  if (!isCanonicalCapabilities(required)) return undefined;
  if (!isOptionalSemVer(value.minimum_client_version)) return undefined;
  if (!isOptionalSemVer(value.current_client_version)) return undefined;
  if (!isBoundedProse(value.display) || !isBoundedProse(value.hint)) return undefined;

  return {
    required_capabilities: required,
    ...(typeof value.minimum_client_version === "string"
      ? { minimum_client_version: value.minimum_client_version }
      : {}),
    ...(typeof value.current_client_version === "string"
      ? { current_client_version: value.current_client_version }
      : {}),
    display: value.display,
    hint: value.hint,
  };
}

export function clientCompatibilityError(status: number, body: string): DvmError | undefined {
  if (status !== 426) return undefined;
  const upgrade = parseClientUpgradeRequired(body);
  if (!upgrade) {
    return new DvmError(
      "invalid_client_upgrade_response",
      "The server requires a client upgrade but returned an invalid compatibility response.",
      "Upgrade or reinstall dvm, then retry. If the response remains invalid, contact the service operator."
    );
  }
  return new DvmError(
    "client_upgrade_required",
    "This request needs a newer dvm client.",
    clientUpgradeHumanGuidance(upgrade),
    {
      required_capabilities: [...upgrade.required_capabilities],
      ...(upgrade.minimum_client_version
        ? { minimum_client_version: upgrade.minimum_client_version }
        : {}),
      ...(upgrade.current_client_version
        ? { current_client_version: upgrade.current_client_version }
        : {}),
      display: upgrade.display,
      hint: upgrade.hint,
    },
    undefined,
    providerProseSources(upgrade)
  );
}

export function clientUpgradeHumanGuidance(
  upgrade: Pick<ClientUpgradeRequired, "required_capabilities" | "minimum_client_version">
): string {
  const requirements = [
    upgrade.required_capabilities.length > 0
      ? `support for ${upgrade.required_capabilities.join(", ")}`
      : undefined,
    upgrade.minimum_client_version
      ? `dvm ${upgrade.minimum_client_version} or newer`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Upgrade or reinstall dvm${requirements.length > 0 ? ` with ${requirements.join(" and ")}` : ""}, then retry.`;
}

function isCanonicalCapabilities(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (token, index) =>
      typeof token === "string" &&
      CAPABILITY_TOKEN_RE.test(token) &&
      (index === 0 || (value[index - 1] as string) < token)
  );
}

function isOptionalSemVer(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && isSemVer(value));
}

function isSemVer(value: string): boolean {
  const match = SEMVER_RE.exec(value);
  if (!match) return false;
  const coreIsSafe = [match[1], match[2], match[3]].every((part) =>
    Number.isSafeInteger(Number(part))
  );
  const prereleaseIsSafe = (match[4]?.split(".") ?? []).every(
    (part) => !/^\d+$/.test(part) || Number.isSafeInteger(Number(part))
  );
  return coreIsSafe && prereleaseIsSafe;
}

function isBoundedProse(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROSE_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CAPABILITY_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const MAX_PROSE_LENGTH = 4_096;

if (!isCanonicalCapabilities(DVM_CLIENT_CAPABILITIES) || !isSemVer(CALLER_VERSION)) {
  throw new Error("caller compatibility metadata is not canonical");
}
