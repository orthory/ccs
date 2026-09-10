// Gateway authentication must be resolved before a transport builds headers.
// Both saved-login and key-based requests get the same CCS credential and URL.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { command } from "./client.ts";
import type { Provider } from "./display.ts";

// ── Provider authentication ─────────────────────────────────────

type PiProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

interface Route {
  provider: string;
  accountProvider: Provider;
  baseUrl: string;
}

export const routes: Route[] = [
  { provider: "anthropic", accountProvider: "claude", baseUrl: "http://127.0.0.1:4141" },
  { provider: "openai-codex", accountProvider: "codex", baseUrl: "http://127.0.0.1:4141/backend-api" },
];

export const gatewayProvider = (base: PiProvider, baseUrl: string, key: string): PiProvider => ({
  ...base,
  baseUrl,
  getModels: () => base.getModels().map(model => ({ ...model, baseUrl })),
  auth: {
    apiKey: {
      name: "CCS gateway",
      check: async () => ({ type: "api_key", source: "CCS gateway" }),
      resolve: async () => ({ auth: { apiKey: key, baseUrl }, source: "CCS gateway" }),
    },
    ...(base.auth.oauth ? { oauth: {
      ...base.auth.oauth,
      toAuth: async () => ({ apiKey: key, baseUrl }),
    } } : {}),
  },
});

export const connect = (pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal): Promise<void> =>
  Promise.resolve()
    .then(() => Promise.all(routes.map(route => Promise.resolve()
      .then(() => command(pi, ["serve", "--key", route.accountProvider], signal))
      .then(key => ({ route, key })))))
    .then(connections => {
      connections.forEach(({ route, key }) => {
        // Rebuild from the built-in provider so reload never nests adapters.
        pi.unregisterProvider(route.provider);
        const base = ctx.modelRegistry.getProvider(route.provider);
        if (!base) throw new Error(`Pi provider unavailable: ${route.provider}`);
        pi.registerProvider(gatewayProvider(base, route.baseUrl, key));
      });
    });
