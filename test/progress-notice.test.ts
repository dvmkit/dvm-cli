vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: output.info }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({ info: vi.fn() }));

// Output uses synchronous fd writes, so observe the module boundary.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  ...output,
}));

const { progressNotice } = await import("../src/lib/progress-notice");

const realStderrIsTty = process.stderr.isTTY;

function setStderrTty(isTty: boolean | undefined): void {
  (process.stderr as { isTTY?: boolean }).isTTY = isTty;
}

beforeEach(() => {
  output.info.mockReset();
});

afterEach(() => {
  setStderrTty(realStderrIsTty);
});

describe("progressNotice", () => {
  it("stays silent when nothing is watching, so piped stdout is the whole document", () => {
    setStderrTty(undefined);
    progressNotice("Searching for providers...");
    progressNotice("Searching for providers...", false);
    expect(output.info).not.toHaveBeenCalled();
  });

  it("narrates on a terminal even in the default JSON mode", () => {
    setStderrTty(true);
    progressNotice("Searching for providers...");
    expect(output.info).toHaveBeenCalledExactlyOnceWith("Searching for providers...");
  });

  it("narrates a redirected --human run, where the prose is the point", () => {
    setStderrTty(undefined);
    progressNotice("Fetching provider info...", true);
    expect(output.info).toHaveBeenCalledExactlyOnceWith("Fetching provider info...");
  });
});
