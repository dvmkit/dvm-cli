import { HttpsTransport } from "./https";

export function createDvmTransport(): HttpsTransport {
  return new HttpsTransport();
}
