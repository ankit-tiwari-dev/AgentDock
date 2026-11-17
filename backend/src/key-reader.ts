import { KeychainError, createKeychain, type KeychainRunner, type KeyProvider } from "./keychain.ts";
import { SupervisorError } from "./supervisor-provider.ts";

export interface KeyReadOptions {
  platform?: NodeJS.Platform;
  runner?: KeychainRunner;
  inContainer?: boolean;
}

/** The backend only ever reads a key; `ctrlplane supervisor set-key` is the one way to save one. */
export async function readKey(provider: KeyProvider, o: KeyReadOptions = {}): Promise<string | null> {
  if (o.inContainer) throw new SupervisorError("KEYCHAIN_UNAVAILABLE", { vars: { inContainer: true } });
  try {
    return await createKeychain({ platform: o.platform, runner: o.runner }).get(provider);
  } catch (err) {
    if (err instanceof KeychainError)
      throw new SupervisorError("KEYCHAIN_UNAVAILABLE", { vars: { hint: err.message } });
    throw err;
  }
}

export async function requireKey(provider: KeyProvider, o: KeyReadOptions = {}): Promise<string> {
  const key = await readKey(provider, o);
  if (key === null) throw new SupervisorError("KEY_MISSING", { vars: { provider } });
  return key;
}

/**
 * Health is fetched on every streamed event and a Windows keychain read starts PowerShell, so the yes/no answer is
 * kept for `maxAgeMs`. Only the boolean is kept, never the key. `null` means the keychain could not be read.
 */
export function keyStatusCache(
  read: (provider: KeyProvider) => Promise<boolean | null>,
  o: { maxAgeMs?: number; now?: () => number } = {},
): (provider: KeyProvider) => Promise<boolean | null> {
  const maxAgeMs = o.maxAgeMs ?? 30_000;
  const now = o.now ?? Date.now;
  const seen = new Map<KeyProvider, { at: number; value: boolean | null }>();
  return async (provider) => {
    const hit = seen.get(provider);
    if (hit && now() - hit.at < maxAgeMs) return hit.value;
    const value = await read(provider);
    seen.set(provider, { at: now(), value });
    return value;
  };
}

export async function hasKey(provider: KeyProvider, o: KeyReadOptions = {}): Promise<boolean | null> {
  if (o.inContainer) return null;
  try {
    return (await readKey(provider, o)) !== null;
  } catch {
    return null;
  }
}
