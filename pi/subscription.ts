// CCS authenticates Anthropic at its gateway even without a saved Pi OAuth
// login. Normalize only requests using that route; Codex remains independent.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { routes } from "./routing.ts";
import installSubscriptionGuard from "./vendor/subscription-guard.ts";

export const usesClaudeGateway = (ctx: ExtensionContext): boolean =>
  routes.some(route => route.provider === "anthropic" && ctx.model?.provider === route.provider && ctx.model.baseUrl === route.baseUrl);

export const installSubscription = (pi: ExtensionAPI): void => {
  installSubscriptionGuard(pi, usesClaudeGateway);
};
