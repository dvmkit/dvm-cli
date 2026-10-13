import { verifyCanonicalSignedRequest } from "@dvmkit/sdk/internal";
import { v2 as nip44 } from "nostr-tools/nip44";
import type { Event as NostrEvent } from "nostr-tools/pure";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { z } from "zod";

export const WALLET_PAIRING_VERSION = 1 as const;
/** Pairing lifetime: the browser capability and relay ciphertext expire together. */
export const WALLET_PAIRING_TTL_SECONDS = 10 * 60;
/** Nostr ephemeral kind used only between the pairing page and dvmkit relay. */
export const WALLET_PAIRING_EVENT_KIND = 24_133;
export const WALLET_PAIRING_MAX_EVENT_BYTES = 16 * 1024;
export const WALLET_PAIRING_RETRY_AFTER_MS = 1_000;
export const WALLET_PAIRING_POLL_JITTER_MS = 400;
export const WALLET_PAIRING_CODE_LENGTH = 12;

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{128}$/);
const hostnameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9.-]+$/);

export const walletPairingManifestSchema = z
  .object({
    pubkey: hex32,
    signature: hex64,
    timestamp: z.number().int().nonnegative(),
    nonce: z.string().min(8).max(64),
    purpose: z.literal("wallet_pairing"),
    version: z.literal(WALLET_PAIRING_VERSION),
    session_id: hex32,
    recipient_pubkey: hex32,
    sender_pubkey: hex32,
    polling_verifier_hash: hex32,
    claimed_hostname: hostnameSchema,
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
    caller_pubkey: hex32,
  })
  .strict();

export type WalletPairingManifest = z.infer<typeof walletPairingManifestSchema>;

/** Encrypted plaintext schema recovered only on the pairing page and CLI. */
export const walletPairingPlaintextSchema = z
  .object({
    purpose: z.literal("wallet_pairing"),
    version: z.literal(WALLET_PAIRING_VERSION),
    session_id: hex32,
    recipient_pubkey: hex32,
    expires_at: z.number().int().nonnegative(),
    nwc_uri: z.string().min(1).max(4_096),
    stated_cap: z.string().min(1).max(160),
  })
  .strict();

export type WalletPairingPlaintext = z.infer<typeof walletPairingPlaintextSchema>;

/** Strict Nostr event wire shape stored by the blind relay. */
export const walletPairingEventSchema = z
  .object({
    id: hex32,
    pubkey: hex32,
    created_at: z.number().int().nonnegative(),
    kind: z.literal(WALLET_PAIRING_EVENT_KIND),
    tags: z.array(z.array(z.string()).min(2).max(4)).min(4).max(8),
    content: z.string().min(1).max(12_000),
    sig: hex64,
  })
  .strict();

export type WalletPairingEvent = z.infer<typeof walletPairingEventSchema>;

/** Compact link capability intentionally kept out of HTTP requests and server logs. */
export interface WalletPairingLink {
  sessionId: string;
  senderPrivateKey: string;
}

/** Verified manifest plus the fragment-only sender capability used by the browser. */
export interface WalletPairingMaterial {
  manifest: WalletPairingManifest;
  senderPrivateKey: string;
}

export interface WalletPairingEventBinding {
  session_id: string;
  recipient_pubkey: string;
  sender_pubkey: string;
  created_at: number;
  expires_at: number;
}

/** Validate the manifest's signature, identity binding, clock, and fixed TTL. */
export function verifyWalletPairingManifest(
  input: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000)
): WalletPairingManifest {
  const manifest = walletPairingManifestSchema.parse(input);
  const { signature, ...unsigned } = manifest;
  if (manifest.pubkey !== manifest.caller_pubkey) throw new Error("Caller identity mismatch");
  if (manifest.created_at !== manifest.timestamp) throw new Error("Creation timestamp mismatch");
  if (manifest.expires_at - manifest.created_at !== WALLET_PAIRING_TTL_SECONDS) {
    throw new Error("Invalid pairing lifetime");
  }
  if (manifest.created_at > nowSeconds + 60 || manifest.expires_at <= nowSeconds) {
    throw new Error("Pairing link is expired or not yet valid");
  }
  if (!verifyCanonicalSignedRequest(unsigned, signature, manifest.pubkey)) {
    throw new Error("Pairing manifest signature is invalid");
  }
  return manifest;
}

/** Encode only the session id and one-time sender secret into a compact URL fragment. */
export function encodeWalletPairingFragment(link: WalletPairingLink): string {
  const sessionId = hex32.parse(link.sessionId);
  const senderPrivateKey = hex32.parse(link.senderPrivateKey);
  return `#${sessionId}.${senderPrivateKey}`;
}

/** Decode and validate fragment syntax without performing trust checks. */
export function decodeWalletPairingFragment(hash: string): WalletPairingLink {
  const match = /^#?([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(hash);
  if (!match) {
    throw new Error("Pairing link is missing its private fragment");
  }
  return { sessionId: match[1], senderPrivateKey: match[2] };
}

/** Verify and bind a relay-fetched manifest to the compact fragment capability. */
export function bindWalletPairingLink(
  link: WalletPairingLink,
  input: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000)
): WalletPairingMaterial {
  const manifest = verifyWalletPairingManifest(input, nowSeconds);
  if (manifest.session_id !== link.sessionId) {
    throw new Error("Pairing session does not match the signed manifest");
  }
  const senderPrivateKey = link.senderPrivateKey;
  if (getPublicKey(hexToBytes(senderPrivateKey)) !== manifest.sender_pubkey) {
    throw new Error("Pairing sender key does not match the signed manifest");
  }
  return { manifest, senderPrivateKey };
}

export function createWalletPairingEvent(
  manifest: WalletPairingManifest,
  senderPrivateKeyHex: string,
  nwcUri: string,
  statedCap: string,
  nowSeconds = Math.floor(Date.now() / 1_000)
): WalletPairingEvent {
  if (!looksLikeNwcUri(nwcUri)) throw new Error("Enter a complete NWC connection URI");
  const plaintext = walletPairingPlaintextSchema.parse({
    purpose: "wallet_pairing",
    version: WALLET_PAIRING_VERSION,
    session_id: manifest.session_id,
    recipient_pubkey: manifest.recipient_pubkey,
    expires_at: manifest.expires_at,
    nwc_uri: nwcUri,
    stated_cap: statedCap.trim(),
  });
  const senderPrivateKey = hexToBytes(senderPrivateKeyHex);
  if (getPublicKey(senderPrivateKey) !== manifest.sender_pubkey) {
    throw new Error("Pairing sender key mismatch");
  }
  const conversationKey = nip44.utils.getConversationKey(
    senderPrivateKey,
    manifest.recipient_pubkey
  );
  const content = nip44.encrypt(JSON.stringify(plaintext), conversationKey);
  return finalizeEvent(
    {
      kind: WALLET_PAIRING_EVENT_KIND,
      created_at: nowSeconds,
      tags: pairingEventTags(manifest),
      content,
    },
    senderPrivateKey
  ) as WalletPairingEvent;
}

/** Verify all public event bindings before a relay stores or a CLI decrypts it. */
export function verifyWalletPairingEvent(
  input: unknown,
  manifest: WalletPairingEventBinding
): WalletPairingEvent {
  const event = walletPairingEventSchema.parse(input);
  if (!verifyEvent(event as NostrEvent)) throw new Error("Submission signature is invalid");
  if (event.pubkey !== manifest.sender_pubkey) throw new Error("Submission sender mismatch");
  if (event.created_at < manifest.created_at || event.created_at > manifest.expires_at) {
    throw new Error("Submission timestamp is outside the pairing session");
  }
  const expected = pairingEventTags(manifest);
  if (JSON.stringify(event.tags) !== JSON.stringify(expected)) {
    throw new Error("Submission tags do not match the pairing session");
  }
  if (!isNip44V2Payload(event.content)) throw new Error("Submission is not NIP-44 v2 ciphertext");
  return event;
}

/** Decrypt and revalidate a signed event using the CLI-only recipient secret. */
export function decryptWalletPairingEvent(
  input: unknown,
  manifest: WalletPairingManifest,
  recipientPrivateKeyHex: string
): WalletPairingPlaintext {
  const event = verifyWalletPairingEvent(input, manifest);
  const recipientPrivateKey = hexToBytes(recipientPrivateKeyHex);
  if (getPublicKey(recipientPrivateKey) !== manifest.recipient_pubkey) {
    throw new Error("Recipient key does not match the pairing session");
  }
  const conversationKey = nip44.utils.getConversationKey(recipientPrivateKey, event.pubkey);
  const plaintext = walletPairingPlaintextSchema.parse(
    JSON.parse(nip44.decrypt(event.content, conversationKey))
  );
  if (
    plaintext.session_id !== manifest.session_id ||
    plaintext.recipient_pubkey !== manifest.recipient_pubkey ||
    plaintext.expires_at !== manifest.expires_at
  ) {
    throw new Error("Decrypted credential is bound to a different pairing session");
  }
  return plaintext;
}

export function pairingFingerprint(hex: string): string {
  return `${hex.slice(0, 12)}…${hex.slice(-8)}`;
}

export function pairingSessionCode(sessionId: string): string {
  return sessionId.slice(0, WALLET_PAIRING_CODE_LENGTH).toUpperCase();
}

/** Browser-safe structural validation for NWC connection strings. */
export function looksLikeNwcUri(uri: string): boolean {
  if (!uri.startsWith("nostr+walletconnect://") || uri.length > 4_096) return false;
  try {
    const url = new URL(uri);
    return (
      /^[0-9a-f]{64}$/i.test(url.hostname) &&
      url.searchParams.getAll("relay").some(Boolean) &&
      /^[0-9a-f]{64}$/i.test(url.searchParams.get("secret") ?? "")
    );
  } catch {
    return false;
  }
}

function pairingEventTags(manifest: WalletPairingEventBinding): string[][] {
  return [
    ["dvmkit", "wallet_pairing", String(WALLET_PAIRING_VERSION)],
    ["session", manifest.session_id],
    ["p", manifest.recipient_pubkey],
    ["expiration", String(manifest.expires_at)],
  ];
}

function isNip44V2Payload(content: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return false;
  try {
    const bytes = base64ToBytes(content);
    return bytes.length >= 97 && bytes.length <= 12_000 && bytes[0] === 2;
  } catch {
    return false;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Invalid private key");
  return Uint8Array.from({ length: 32 }, (_, index) =>
    parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
}
