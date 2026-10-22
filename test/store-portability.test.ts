import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  failure: "" as string,
  events: [] as string[],
  directories: new Set<number>(),
  wrap(actual: typeof import("node:fs")) {
    const operation = (name: string) => {
      boundary.events.push(name);
      if (boundary.failure === name) throw new Error(`injected ${name} failure`);
    };
    return {
      ...actual,
      openSync: (...args: Parameters<typeof actual.openSync>) => {
        const directory = actual.existsSync(args[0]) && actual.statSync(args[0]).isDirectory();
        if (directory) operation("directory-open");
        const fd = actual.openSync(...args);
        if (directory) boundary.directories.add(fd);
        return fd;
      },
      closeSync: (fd: number) => {
        boundary.directories.delete(fd);
        actual.closeSync(fd);
      },
      writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
        operation("file-write");
        return Reflect.apply(actual.writeFileSync, actual, args);
      },
      fsyncSync: (fd: number) => {
        operation(boundary.directories.has(fd) ? "directory-sync" : "file-sync");
        actual.fsyncSync(fd);
      },
      renameSync: (...args: Parameters<typeof actual.renameSync>) => {
        operation("rename");
        actual.renameSync(...args);
      },
    };
  },
}));

vi.mock("fs", async () => boundary.wrap(await vi.importActual<typeof import("node:fs")>("node:fs")));
vi.mock("node:fs", async () => boundary.wrap(await vi.importActual<typeof import("node:fs")>("node:fs")));

import { JOBS_FILE, REQUEST_INTENTS_DIR, FAVORITES_FILE } from "@dvmkit/sdk/internal";
import { rmSync } from "node:fs";
import { loadJob, saveJob } from "../src/lib/job-store";
import { loadRequestIntent, saveRequestIntent } from "../src/lib/request-intent-store";
import { loadFavorites, saveFavorite } from "../src/lib/favorites";

const job = { id: "portable-job", endpoint: "https://provider.invalid", status: "submitted" as const, submittedAt: 1 };
const intent = {
  v: 2 as const,
  requestId: "portable-request",
  endpoint: "https://provider.invalid",
  capability: "count",
  body: { input: "hello" },
  callerPubkey: "a".repeat(64),
  policy: { maxTotalMsats: 0, autoPayBelowMsats: 0, maxIncrementMsats: 0, maxPayments: 0 },
  authAudience: { dvm_id: "portable", builder_pubkey: "b".repeat(64) },
  createdAt: 1,
};
const favorite = { endpoint: "https://provider.invalid", addedAt: 1 };
const stores = [
  { name: "jobs", save: () => saveJob(job), read: () => loadJob(job.id), expected: job, directorySyncs: 1 },
  { name: "request intents", save: () => saveRequestIntent(intent), read: () => loadRequestIntent(intent.requestId), expected: intent, directorySyncs: 2 },
  { name: "favorites", save: () => saveFavorite("portable", favorite), read: () => loadFavorites(), expected: { portable: favorite }, directorySyncs: 1 },
];
const originalPlatform = process.platform;
function platform(value: string) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

beforeEach(() => {
  boundary.failure = "";
  boundary.events = [];
  boundary.directories.clear();
  for (const path of [JOBS_FILE, REQUEST_INTENTS_DIR, FAVORITES_FILE]) {
    rmSync(path, { recursive: true, force: true });
  }
});
afterEach(() => platform(originalPlatform));

describe.each(stores)("$name persistence durability", (store) => {
  it.each(["directory-open", "directory-sync"])("saves readable Windows state when %s is unsupported", async (failure) => {
    platform("win32");
    boundary.failure = failure;
    await store.save();
    expect(store.read()).toEqual(store.expected);
    expect(boundary.events).toEqual(["file-write", "file-sync", "rename"]);
  });

  it("syncs file contents before atomic replacement and syncs POSIX directory entries", async () => {
    platform("linux");
    await store.save();
    expect(store.read()).toEqual(store.expected);
    const fileSync = boundary.events.indexOf("file-sync");
    const rename = boundary.events.indexOf("rename");
    expect(fileSync).toBeGreaterThan(boundary.events.indexOf("file-write"));
    expect(rename).toBeGreaterThan(fileSync);
    expect(boundary.events.filter((event) => event === "directory-sync")).toHaveLength(store.directorySyncs);
    expect(boundary.events.slice(rename + 1)).toEqual(["directory-open", "directory-sync"]);
  });

  it.each([
    ["win32", "file-write"], ["win32", "file-sync"], ["win32", "rename"],
    ["linux", "file-write"], ["linux", "file-sync"], ["linux", "rename"],
    ["linux", "directory-open"], ["linux", "directory-sync"],
  ])("propagates %s %s errors", async (os, failure) => {
    platform(os);
    boundary.failure = failure;
    await expect(Promise.resolve().then(() => store.save())).rejects.toThrow(`injected ${failure} failure`);
  });
});
