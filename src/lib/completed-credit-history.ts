import {
  readCompletedCreditHistory,
  dvmLocationIdentity,
  type CompletedCreditHistoryQuery,
  type CompletedCreditHistoryRecord,
  type CompletedRefundHistoryRecord,
  type StoredCredit,
} from "@dvmkit/sdk/internal";

// Each SDK page belongs to the same journal snapshot. The merged CLI view also
// includes ledger and active-store rows, so its offsets apply to the final view.
export function completedCreditHistory(
  query: Pick<CompletedCreditHistoryQuery, "endpoint" | "callerPubkey"> = {},
): CompletedCreditHistoryRecord[] {
  const records: CompletedCreditHistoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = readCompletedCreditHistory({
      ...query,
      order: "desc",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

// A partial identity claim does not authenticate relocation. Both complete
// attested pairs must agree; otherwise only recorded origins/aliases can match.
export function completedDrainMatches(
  record: CompletedRefundHistoryRecord,
  credit: StoredCredit,
  drain: { creditId?: string; drainId: string },
): boolean {
  if (
    record.callerPubkey !== credit.callerPubkey ||
    record.creditId !== drain.creditId ||
    record.drainId !== drain.drainId
  )
    return false;
  return completedServiceMatches(record, credit);
}

export function completedServiceMatches(
  record: CompletedCreditHistoryRecord,
  credit: StoredCredit,
): boolean {
  const archivedIdentity = dvmLocationIdentity({
    endpoint: record.endpoint,
    dvmId: record.dvmId ?? undefined,
    attestedBuilderPubkey: record.attestedBuilderPubkey ?? undefined,
  });
  const currentIdentity = dvmLocationIdentity(credit);
  if (archivedIdentity && currentIdentity) {
    return (
      archivedIdentity.dvmId === currentIdentity.dvmId &&
      archivedIdentity.builderPubkey === currentIdentity.builderPubkey
    );
  }
  return completedOriginsOverlap(record, credit);
}

export function completedOriginsOverlap(
  record: CompletedCreditHistoryRecord,
  credit: StoredCredit,
): boolean {
  const origins = [credit.endpoint, ...(credit.endpointAliases ?? [])].map(
    origin,
  );
  return [record.endpoint, ...record.endpointAliases].some((endpoint) =>
    origins.includes(origin(endpoint)),
  );
}

function origin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}
