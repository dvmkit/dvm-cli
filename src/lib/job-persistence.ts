import { AsyncLocalStorage } from "node:async_hooks";
import type { JobRecord } from "./job-store";

interface JobPersistenceSession {
  unsaved?: JobRecord[];
  warn: () => void;
}

export const jobPersistence = new AsyncLocalStorage<JobPersistenceSession>();

/** Unsaved observations must never authorize another payment in this command. */
export function hasUnsavedJobState(): boolean {
  return jobPersistence.getStore()?.unsaved !== undefined;
}

export function withJobPersistence<T>(run: () => Promise<T>, warn: () => void): Promise<T> {
  if (jobPersistence.getStore()) return run();
  return jobPersistence.run({ warn }, run);
}
