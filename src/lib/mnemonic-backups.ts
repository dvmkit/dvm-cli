import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface MnemonicBackup {
  path: string;
  modifiedAt: string;
  ageMs: number;
  ageDays: number;
  age: string;
}

export interface MnemonicBackupWarning {
  display: string;
  hint: string;
  details: {
    count: number;
    paths: string[];
    backups: MnemonicBackup[];
  };
}

/**
 * Find timestamped `.bak` siblings of a mnemonic file, oldest first.
 *
 * The writer creates `<mnemonic>.<timestamp>.bak`; matching that narrow prefix
 * avoids treating unrelated backup files in the config directory as recovery
 * words. A missing config directory is the clean, never-initialized case.
 */
export function findMnemonicBackups(mnemonicFile: string, nowMs = Date.now()): MnemonicBackup[] {
  const dir = dirname(mnemonicFile);
  const prefix = `${basename(mnemonicFile)}.`;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      if (!stat.isFile()) return null;

      const ageMs = Math.max(0, nowMs - stat.mtimeMs);
      return {
        path,
        modifiedAt: stat.mtime.toISOString(),
        ageMs,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
        age: formatMnemonicBackupAge(ageMs),
      };
    })
    .filter((backup): backup is MnemonicBackup => backup !== null)
    .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
}

export function describeMnemonicBackups(
  mnemonicFiles: string | readonly string[],
  nowMs = Date.now()
): MnemonicBackupWarning | null {
  const files = [...new Set(typeof mnemonicFiles === "string" ? [mnemonicFiles] : mnemonicFiles)];
  const backups = files
    .flatMap((mnemonicFile) => findMnemonicBackups(mnemonicFile, nowMs))
    .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
  if (backups.length === 0) return null;

  const listed = backups.map((backup) => `${backup.path} (${backup.age})`).join("; ");
  const single = backups.length === 1;
  return {
    display: `${backups.length} plaintext recovery-mnemonic backup${single ? "" : "s"} remain${single ? "s" : ""} on disk: ${listed}.`,
    hint: `Each file contains older recovery words. Deleting ${single ? "it is" : "them is"} safe once your password-manager and offline backups are refreshed; until then ${single ? "it is a rescue copy" : "they are rescue copies"} of an earlier derivation root.`,
    details: {
      count: backups.length,
      paths: backups.map((backup) => backup.path),
      backups,
    },
  };
}

export function formatMnemonicBackupAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "less than a minute old";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} old`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} old`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
}
