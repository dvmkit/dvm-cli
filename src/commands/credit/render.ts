import {
  info,
  json,
} from "../../lib/output";

export interface CreditCommandOutput {
  human: boolean;
  humanLines: readonly string[];
  json: Record<string, unknown>;
}

export function renderCreditBalance(output: CreditCommandOutput): void {
  if (output.human) {
    for (const line of output.humanLines) info(line);
    return;
  }
  json(output.json);
}

export function renderCreditFunding(output: CreditCommandOutput): void {
  if (output.human) {
    for (const line of output.humanLines) info(line);
    return;
  }
  json(output.json);
}

export function renderCreditDrain(output: CreditCommandOutput): void {
  if (output.human) {
    for (const line of output.humanLines) info(line);
    return;
  }
  json(output.json);
}

export function renderCreditReceipts(output: CreditCommandOutput): void {
  if (output.human) {
    for (const line of output.humanLines) info(line);
    return;
  }
  json(output.json);
}
