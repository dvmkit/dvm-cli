export interface ErrorCodeInventory {
  codes: string[];
  families: string[];
}

export interface ErrorCodeSource {
  file: string;
  owner: string;
  expression: string;
  path: string[];
  reason: string;
  argument?: number;
  local?: { file: string; name: string };
  guard?: { file: string; name: string; sha256: string };
}

export function discoverErrorCodes(sourceRoot: string, relays?: ErrorCodeSource[]): ErrorCodeInventory;
