/**
 * Resolve a secret (BIP-39 mnemonic, EVM private key, …) for a CLI command
 * from one of five sources, in priority order, without leaking it via shell
 * history, `ps aux`, or `/proc/<pid>/cmdline` .
 *
 * Priority:
 *   1. `--file <path>` (or equivalent flag) — read from a file. The path is
 *      rejected if it resolves under a shell-history location or a
 *      world-readable temp directory; {@link BLOCKED_SECRET_PATHS} is the list,
 *      and the only place it is written down.
 *   2. Environment variable (caller passes the resolved value via
 *      `envValue`) — process-local, not in shell history.
 *   3. Positional arg — emits a stderr warning (the secret is now in the
 *      caller's shell history + process list).
 *   4. Piped stdin (`process.stdin.isTTY === false`) — drains stdin to EOF.
 *   5. Interactive no-echo prompt to stderr.
 *
 * The caller passes a {@link SecretInputConfig} carrying the secret-specific
 * copy (prompt label, warning command examples, error wording) so this
 * module stays agnostic to what the secret is.
 */
import {
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";
import { fstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Every location a secret file may not resolve to, in the display form the CLI
 * publishes: `~` stands for the caller's home directory, and a trailing `/`
 * marks an entry whose *contents* are refused rather than the path itself.
 *
 * One list rather than one per surface. `assertSafeFilePath` expands
 * these against the real home, and every string that enumerates them — each
 * `--file` / `--key-file` flag description, the `unsafe_file_path` hint — is
 * rendered from {@link BLOCKED_SECRET_PATHS_LIST}.
 *
 * Adding an entry here blocks it and publishes it in the same edit.
 */
export const BLOCKED_SECRET_PATHS = [
  "~/.bash_history",
  "~/.zsh_history",
  "~/.fish_history",
  "~/.history",
  "~/.zsh_sessions/",
  "~/.local/share/fish/",
  "/tmp/",
  "/private/tmp/",
  "/var/tmp/",
] as const;

export const BLOCKED_SECRET_PATHS_LIST = BLOCKED_SECRET_PATHS.join(", ");

export type SecretSource = "positional" | "env" | "file" | "stdin" | "prompt";

export interface SecretInputConfig {
  /**
   * Short human-language label for the secret (`"mnemonic"`, `"private key"`).
   * Used in error hints and the stdin-timeout message.
   */
  kind: string;
  /** Prompt shown to stderr in interactive-prompt mode (no trailing space). */
  promptLabel: string;
  /**
   * Example commands listed in the positional-arg warning, one per safer
   * alternative the user can switch to. Rendered verbatim, two-space indent.
   */
  warningCommands: string[];
}

export interface ResolveSecretArgs {
  positional?: string;
  file?: string;
  /**
   * Pre-resolved env-var value (e.g. `process.env.DVM_X402_KEY`). When set
   * and no `file` was supplied, returned as `source: "env"` without warning.
   * Omit (or leave undefined) for callers without an env-var convention.
   */
  envValue?: string;
  config: SecretInputConfig;
}

export interface PositionalRefusalCopy {
  /**
   * Error code carried by both arms. One code per command, so an agent
   * pattern-matches a single refusal per rail rather than two.
   */
  code: string;
  /**
   * Where the secret actually goes, as a full sentence. Prepended to the
   * shared rotate advice on the key-shaped arm.
   */
  keyRemedy: string;
  /** Message for a value that isn't key-shaped. Never interpolates the value. */
  message: string;
  hint: string;
}

export interface ResolvedSecret {
  /** The raw secret string (still needs trim + validation by the caller). */
  value: string;
  source: SecretSource;
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const DEL = "\u007f";
const BACKSPACE = "\b";
const STDIN_TIMEOUT_MS = 10_000;
/** A 32-byte hex private key, `0x` prefix optional. See {@link refusePositionalSecret}. */
const POSITIONAL_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Resolve the secret input for a CLI command. See file header for priority +
 * safety rules.
 */
export async function resolveSecretInput(args: ResolveSecretArgs): Promise<ResolvedSecret> {
  const positional = args.positional;
  const positionalSupplied = positional !== undefined && positional !== "";
  let resolved: ResolvedSecret;

  try {
    if (args.file) {
      resolved = { value: readSecretFile(args.file, args.config), source: "file" };
    } else if (args.envValue !== undefined && args.envValue !== "") {
      resolved = { value: args.envValue, source: "env" };
    } else if (positionalSupplied) {
      resolved = { value: positional, source: "positional" };
    } else if (!process.stdin.isTTY) {
      resolved = { value: await readSecretStdin(args.config), source: "stdin" };
    } else {
      resolved = { value: await promptSecretHidden(args.config), source: "prompt" };
    }
  } catch (err) {
    // The argv value leaked before source resolution began. Warn even when a
    // higher-priority source fails, but do not claim that another value won.
    if (positionalSupplied) emitPositionalWarning(args.config);
    throw err;
  }

  if (positionalSupplied) {
    const ignoredFor =
      resolved.source === "file" || resolved.source === "env" ? resolved.source : undefined;
    emitPositionalWarning(args.config, ignoredFor, resolved.value !== positional);
  }
  return resolved;
}

/**
 * Refuse a positional argument on a command that accepts no secret there
 * The invariant both stablecoin connect verbs hold: a
 * connect verb never takes a secret positionally.
 *
 * The supplied value is never echoed. `handleError` spreads `message`,
 * `display`, `hint` and every key of `data` into JSON on stdout, which is the
 * channel an agent parses and may relay onward, so a refusal that quotes what
 * it refused publishes the key a second time.
 *
 * A key-shaped value gets its own copy, because by the time this runs the leak
 * has already happened in the caller's shell and only rotation undoes it. The
 * shape test is deliberately looser than the rails' own import validators — it
 * trims, and it makes the `0x` prefix they require optional. This is a leak
 * detector, not an import gate: `dvm wallet x402-connect "$KEY "` leaked a real
 * key, and losing the rotate advice to a stray space is the one failure that
 * costs money.
 */
export function refusePositionalSecret(value: string, copy: PositionalRefusalCopy): DvmError {
  if (!POSITIONAL_KEY_RE.test(value.trim())) {
    return new DvmError(copy.code, copy.message, copy.hint);
  }
  return new DvmError(
    copy.code,
    "A private key was passed as a positional argument. It was not saved, and its value is withheld from this error.",
    `${copy.keyRemedy} The key you typed has already leaked to your shell history, process listings (ps), and /proc/<pid>/cmdline on Linux — rotate it if it holds funds.`
  );
}

/**
 * Whether stdin *could* carry piped content — a pipe (`cat key | dvm …`) or a
 * redirected file (`dvm … < key.txt`).
 *
 * A command that generates a secret when none was supplied can't use
 * `!process.stdin.isTTY` to answer this. The primary caller is an
 * agent, and an agent harness routinely hands its child `/dev/null` or an idle
 * pipe it never writes to; `isTTY` is false for both, so the command would
 * drain stdin until the 10s timeout and fail instead of generating.
 *
 * An `fstat` settles only half of that: it rules out a character device (a
 * terminal, `/dev/null`) and an fd that can't be stat'd. A pipe the harness
 * opened and never wrote to is a FIFO, indistinguishable here from one about to
 * deliver a key — only reading tells them apart. So a generate-on-no-secret
 * caller must treat an empty or timed-out stdin read as "nothing was supplied"
 * too; this function narrows the cases where it has to read at all.
 */
export function hasPipedStdin(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Read secret content from a file. Rejects paths that resolve under known
 * shell-history locations or world-readable temp directories — those are the
 * exact paths the user is trying to avoid by switching off positional args.
 * Follows symlinks via `realpathSync` so `--file ~/safe → ~/.bash_history`
 * still trips the safety check.
 */
export function readSecretFile(path: string, config: SecretInputConfig): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DvmError(
        "secret_file_missing",
        `${capitalise(config.kind)} file not found: ${path}`,
        `Check the --file path is correct and the file exists. The file should contain only the ${config.kind} (whitespace is trimmed).`
      );
    }
    throw err;
  }
  assertSafeFilePath(real);
  return readFileSync(real, "utf-8").trim();
}

/**
 * Read secret from piped stdin (drained to EOF, trimmed). Times out after
 * 10s — humans pasting from a password manager need more than the 1s budget
 * `dvm request` uses for structured job input.
 */
export function readSecretStdin(config: SecretInputConfig): Promise<string> {
  return new Promise((resolveStdin, reject) => {
    const timer = setTimeout(() => {
      process.stdin.destroy();
      reject(
        new DvmError(
          "no_input",
          `No ${config.kind} received on stdin (timed out after 10s).`,
          `Pipe the ${config.kind} in via stdin, pass --file <path>, or run interactively for a prompt.`
        )
      );
    }, STDIN_TIMEOUT_MS);

    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolveStdin(data.trim());
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Interactive no-echo prompt — TTY raw-mode read until newline, prompt
 * written to stderr so stdout stays reserved for the command's JSON output.
 * Handles backspace; aborts on Ctrl-C (exit 130); treats Ctrl-D as
 * end-of-input.
 */
export function promptSecretHidden(config: SecretInputConfig): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new DvmError(
          "no_input",
          "No interactive terminal available for hidden prompt.",
          `Pipe the ${config.kind} via stdin or pass --file <path>.`
        )
      );
      return;
    }
    process.stderr.write(`${config.promptLabel} `);

    let buffer = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolvePrompt(buffer);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === CTRL_D) {
          cleanup();
          process.stderr.write("\n");
          resolvePrompt(buffer);
          return;
        }
        if (ch === DEL || ch === BACKSPACE) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    stdin.on("data", onData);
  });
}

function emitPositionalWarning(
  config: SecretInputConfig,
  ignoredFor?: "file" | "env",
  differentValue = false
): void {
  const examples = config.warningCommands.map((c) => `  ${c}`).join("\n");
  const source = ignoredFor === "file" ? "the file" : "the environment variable";
  const ignored = !ignoredFor
    ? ""
    : differentValue
      ? ` The value you passed on the command line was ignored, and a different value from ${source} was used instead.`
      : ` The value you passed on the command line was ignored; the same value was read from ${source} instead.`;
  info(
    `WARNING: passing the ${config.kind} on the command line leaks it to your shell history, process listings (ps), and /proc/<pid>/cmdline on Linux.${ignored} Treat that command-line ${config.kind} as compromised and rotate it anywhere it remains valid. Prefer one of:\n` +
      examples
  );
}

function assertSafeFilePath(resolvedPath: string): void {
  const home = homedir();
  for (const entry of BLOCKED_SECRET_PATHS) {
    const absolute = expandBlockedPath(entry, home);
    if (!entry.endsWith("/")) {
      if (resolvedPath === absolute) throw unsafePathError(resolvedPath, "shell history file");
      continue;
    }
    if (resolvedPath === absolute || resolvedPath.startsWith(absolute + sep)) {
      throw unsafePathError(resolvedPath, "shell-history or world-readable temp directory");
    }
  }
}

/**
 * One {@link BLOCKED_SECRET_PATHS} entry as an absolute, platform-separated
 * path: `~` becomes the real home, the directory marker is dropped, and the
 * leading empty segment of an absolute entry supplies the root separator.
 */
function expandBlockedPath(entry: string, home: string): string {
  const segments = entry.replace(/\/$/, "").split("/");
  return segments[0] === "~" ? [home, ...segments.slice(1)].join(sep) : segments.join(sep);
}

function unsafePathError(resolvedPath: string, reason: string): DvmError {
  return new DvmError(
    "unsafe_file_path",
    `Refusing to read secret from ${resolvedPath} — it resolves under a ${reason}.`,
    `Move the file outside shell-history and temp paths (or use \`mktemp\` in your home, \`shred -u\` after). Blocked locations: ${BLOCKED_SECRET_PATHS_LIST}.`
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
