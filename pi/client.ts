// CCS owns credentials, polling and switching. Pi consumes its public CLI,
// so no account file or refresh token is interpreted by the extension.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Account, Provider } from "./display.ts";

// ── CLI boundary ───────────────────────────────────────────────

export const command = (pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<string> =>
  Promise.resolve()
    .then(() => pi.exec("ccs", args, { signal }))
    .then(result => {
      if (result.code !== 0) throw new Error(result.stderr.trim() || `ccs ${args[0]} failed (${result.code})`);
      return result.stdout.trim();
    });

export const accounts = (pi: ExtensionAPI, signal?: AbortSignal): Promise<Account[]> =>
  Promise.resolve()
    .then(() => command(pi, ["ls", "--cached", "--json"], signal))
    .then(text => JSON.parse(text) as Account[]);

export const activeAccount = (pi: ExtensionAPI, provider: Provider, signal?: AbortSignal): Promise<Account | undefined> =>
  Promise.resolve()
    .then(() => accounts(pi, signal))
    .then(rows => {
      const active = rows.find(row => row.provider === provider && row.active);
      if (active) return active;
      // The gateway identifies live credentials when no active pointer exists.
      return Promise.resolve()
        .then(() => command(pi, ["status", `--${provider}`, "--cached", "--json"], signal))
        .then(text => JSON.parse(text) as Account);
    });
