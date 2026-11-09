import { AsyncLocalStorage } from "node:async_hooks";
import type { JobRecord } from "./job-store";

export interface JobPersistenceWarning {
  accessPreserved: boolean;
  accessUnpreserved: boolean;
}

interface JobPersistenceSession {
  unsaved?: JobRecord[];
  accepted?: { id: string; endpoint: string; accessId: string; sequence: number; preserved: boolean; snapshot?: string }[];
  warn: (state: JobPersistenceWarning) => void;
}

export const jobPersistence = new AsyncLocalStorage<JobPersistenceSession>();

/** Unsaved observations must never authorize another payment in this command. */
export function hasUnsavedJobState(): boolean {
  return jobPersistence.getStore()?.unsaved !== undefined;
}

export function withJobPersistence<T>(run: () => Promise<T>, warn: (state: JobPersistenceWarning) => void): Promise<T> {
  if (jobPersistence.getStore()) return run();
  return jobPersistence.run({ warn }, run);
}
