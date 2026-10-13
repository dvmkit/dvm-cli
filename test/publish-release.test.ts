import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPublishedRelease, publishRelease } from "../scripts/publish-release.mjs";

const temporaryRoots: string[] = [];
const registry = "https://registry.test";
const packageName = "@dvmkit/dvm-cli";
const packageVersion = "1.2.3-rc.1";

describe("release publication recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("accepts an exact existing version without publishing it again", async () => {
    const archive = makeArchive();
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({ archive, distTag: "next", fetchFn: matchingRegistry(archive), publishFn, registry })
    ).resolves.toBe("already-published");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("waits for an existing version's pending archive without publishing", async () => {
    const archive = makeArchive();
    let tarballRequests = 0;
    const fetchFn = metadataWithTarballResponse(() =>
      tarballRequests++ === 0 ? new Response(null, { status: 404 }) : new Response(readFileSync(archive))
    );
    const clock = fakeClock();
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({
        archive, distTag: "next", fetchFn, publishFn, registry, retryDelayMs: 17,
        waitFn: clock.wait, nowFn: clock.now, signalFn: fakeSignal,
      })
    ).resolves.toBe("already-published");
    expect(publishFn).not.toHaveBeenCalled();
    expect(clock.wait).toHaveBeenCalledExactlyOnceWith(17);
  });

  it("waits beyond three minutes for an accepted upload and never republishes", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const exactRegistry = matchingRegistry(archive);
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) =>
      clock.now() < 4 * 60 * 1_000 ? new Response(null, { status: 404 }) : exactRegistry(input, init)
    );
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({
        archive, distTag: "next", fetchFn, publishFn, registry, retryDelayMs: 15_000,
        waitFn: clock.wait, nowFn: clock.now, signalFn: fakeSignal,
      })
    ).resolves.toBe("published");
    expect(clock.now()).toBe(4 * 60 * 1_000);
    expect(publishFn).toHaveBeenCalledOnce();
  });

  it("accounts for response-body latency in the total deadline", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const signals: number[] = [];
    const fetchFn = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => {
        clock.advance(501);
        return registryMetadataBody();
      },
    })) as unknown as typeof fetch;
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({
        archive, distTag: "next", fetchFn, publishFn, registry,
        availabilityTimeoutMs: 500, requestTimeoutMs: 2_000, nowFn: clock.now,
        signalFn: (milliseconds: number) => { signals.push(milliseconds); return fakeSignal(milliseconds); },
      })
    ).rejects.toThrow("availability deadline expired during registry I/O");
    expect(signals).toEqual([500]);
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("keeps a bounded signal active through archive body reads", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const signals: number[] = [];
    let archiveSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === `/${encodeURIComponent(packageName)}`) return registryMetadata();
      archiveSignal = init?.signal;
      return {
        status: 200,
        ok: true,
        arrayBuffer: async () => {
          clock.advance(501);
          return readFileSync(archive);
        },
      };
    }) as unknown as typeof fetch;
    await expect(
      publishRelease({
        archive, distTag: "next", fetchFn, publishFn: vi.fn(async () => publishSuccess()), registry,
        availabilityTimeoutMs: 500, requestTimeoutMs: 2_000, nowFn: clock.now,
        signalFn: (milliseconds: number) => { signals.push(milliseconds); return fakeSignal(milliseconds); },
      })
    ).rejects.toThrow("availability deadline expired during registry I/O");
    expect(signals).toEqual([500, 500]);
    expect(archiveSignal).toBeDefined();
  });

  it("stops exactly at the wall-clock deadline and explains possible processing", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({
        archive, distTag: "next", fetchFn, publishFn, registry,
        availabilityTimeoutMs: 100, retryDelayMs: 40, waitFn: clock.wait,
        nowFn: clock.now, signalFn: fakeSignal,
      })
    ).rejects.toThrow("may be processing. Do not publish again");
    expect(clock.now()).toBe(100);
    expect(clock.wait).toHaveBeenLastCalledWith(20);
    expect(publishFn).toHaveBeenCalledOnce();
  });

  it("bounds the one upload attempt by the remaining deadline and treats timeout as ambiguous", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const publishFn = vi.fn(async () => {
      clock.advance(100);
      return {
        status: null,
        signal: "SIGKILL" as const,
        error: Object.assign(new Error("process timed out after 100ms"), { code: "ETIMEDOUT" }),
      };
    });

    await expect(
      publishRelease({
        archive,
        distTag: "next",
        fetchFn: vi.fn(async () => new Response(null, { status: 404 })),
        publishFn,
        registry,
        availabilityTimeoutMs: 100,
        nowFn: clock.now,
        signalFn: fakeSignal,
      })
    ).rejects.toThrow("upload outcome unknown");

    expect(publishFn).toHaveBeenCalledExactlyOnceWith({
      archive,
      distTag: "next",
      timeoutMs: 100,
    });
  });

  it("fails closed on different bytes and never publishes", async () => {
    const archive = makeArchive();
    const publishFn = vi.fn(async () => publishSuccess());
    await expect(
      publishRelease({ archive, distTag: "next", fetchFn: matchingRegistry(Buffer.from("different")), publishFn, registry })
    ).rejects.toThrow("does not match the reviewed archive and dist-tag");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("offers a read-only exact-byte and dist-tag recovery check", async () => {
    const archive = makeArchive();
    await expect(
      checkPublishedRelease({ archive, distTag: "next", fetchFn: matchingRegistry(archive), registry, signalFn: fakeSignal })
    ).resolves.toBe("match");
  });

  it("wraps post-upload inspection failure with no-republish recovery guidance", async () => {
    const archive = makeArchive();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"));
    const publishFn = vi.fn(async () => publishSuccess());

    await expect(
      publishRelease({ archive, distTag: "next", fetchFn, publishFn, registry, signalFn: fakeSignal })
    ).rejects.toThrow(
      "request timed out. The upload may still be processing. Do not publish again"
    );
    expect(publishFn).toHaveBeenCalledOnce();
  });

  it("wraps inspection failure while an existing archive is processing without publishing", async () => {
    const archive = makeArchive();
    const clock = fakeClock();
    const pendingRegistry = metadataWithTarballResponse(() => new Response(null, { status: 404 }));
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(pendingRegistry)
      .mockImplementationOnce(pendingRegistry)
      .mockRejectedValueOnce(new DOMException("body timed out", "TimeoutError"));
    const publishFn = vi.fn(async () => publishSuccess());

    await expect(
      publishRelease({
        archive,
        distTag: "next",
        fetchFn,
        publishFn,
        registry,
        retryDelayMs: 1,
        waitFn: clock.wait,
        nowFn: clock.now,
        signalFn: fakeSignal,
      })
    ).rejects.toThrow("body timed out. No publish was attempted");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("rejects malformed read-only flags and unknown options before any publish path", () => {
    const script = resolve(import.meta.dirname, "../scripts/publish-release.mjs");
    for (const args of [
      ["--archive", "/unused", "--dist-tag", "next", "--check", "TRUE"],
      ["--archive", "/unused", "--dist-tag", "next", "--unknown", "true"],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--check must be exactly true|unknown option/u);
      expect(result.stderr).not.toContain("ENOENT");
    }
  });
});

function makeArchive() {
  const root = mkdtempSync(join(tmpdir(), "dvm-cli-publish-release-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const packageRoot = join(source, "package");
  const archive = join(root, "package.tgz");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: packageName, version: packageVersion })}\n`);
  writeFileSync(join(packageRoot, "README.md"), "release fixture\n");
  execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
  return archive;
}

function matchingRegistry(archiveOrBytes: string | Buffer, distTagVersion = packageVersion) {
  const bytes = typeof archiveOrBytes === "string" ? readFileSync(archiveOrBytes) : archiveOrBytes;
  return metadataWithTarballResponse(() => new Response(Uint8Array.from(bytes)), distTagVersion);
}

function metadataWithTarballResponse(tarballResponse: () => Response | Promise<Response>, distTagVersion = packageVersion) {
  const tarball = `${registry}/@dvmkit/dvm-cli/-/dvm-cli-${packageVersion}.tgz`;
  return vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === `/${encodeURIComponent(packageName)}`) return registryMetadata({ distTagVersion });
    if (url.href === tarball) return tarballResponse();
    return new Response(null, { status: 404 });
  });
}

function registryMetadata({ packageName: name = packageName, distTagVersion = packageVersion } = {}) {
  return Response.json(registryMetadataBody({ name, distTagVersion }));
}

function registryMetadataBody({ name = packageName, distTagVersion = packageVersion } = {}) {
  const tarball = `${registry}/@dvmkit/dvm-cli/-/dvm-cli-${packageVersion}.tgz`;
  return {
    "dist-tags": { next: distTagVersion },
    versions: { [packageVersion]: { name, version: packageVersion, dist: { tarball } } },
  };
}

function fakeClock(start = 0) {
  let now = start;
  return {
    now: vi.fn(() => now),
    wait: vi.fn(async (milliseconds: number) => { now += milliseconds; }),
    advance(milliseconds: number) { now += milliseconds; },
  };
}

function fakeSignal(_milliseconds: number): AbortSignal {
  return new AbortController().signal;
}

function publishSuccess() {
  return { status: 0, stdout: "", stderr: "" };
}
