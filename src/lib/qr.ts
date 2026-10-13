import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toFile as qrToFile, toString as qrToString } from "qrcode";

export async function renderQrTerminal(payload: string): Promise<string> {
  return qrToString(payload, { type: "terminal", small: true });
}

export async function renderQrPng(payload: string, outPath: string): Promise<void> {
  await qrToFile(outPath, payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8,
  });
}

export function defaultQrImagePath(prefix = "dvm-wallet-fund"): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.png`);
}
