// A Pi session routes through CCS and displays the account that CCS will use.
// Gateway authentication replaces request credentials without changing auth.json.
// The native footer continues to own model, checkout and context information.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installAccountBorder, type AccountBorder } from "./border.ts";
import { accounts, activeAccount, command } from "./client.ts";
import { accountText, providerFor, type Account, type Provider } from "./display.ts";
import { connect, routes } from "./routing.ts";
import { installSubscription } from "./subscription.ts";

// ── Status and commands ────────────────────────────────────────

const show = (ctx: ExtensionContext, account: Account, border: AccountBorder): void => {
  const text = accountText(account, Date.now(), (color, value) => ctx.ui.theme.fg(color, value));
  border.set(ctx.ui.theme.fg("muted", `CCS · ${text}`));
};

const refresh = (pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal, border: AccountBorder): Promise<void> => {
  const provider = providerFor(ctx.model?.provider);
  if (!provider) {
    border.set();
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => activeAccount(pi, provider, signal))
    .then(account => {
      const obsolete = signal.aborted || provider !== providerFor(ctx.model?.provider);
      if (obsolete) return;
      if (!account) return border.set("CCS · no active account");
      show(ctx, account, border);
    })
    .catch(error => {
      if (signal.aborted) return;
      border.set(ctx.ui.theme.fg("error", `CCS · ${String(error)}`));
    });
};

const chooseAccount = (pi: ExtensionAPI, ctx: ExtensionContext, provider: Provider): Promise<void> =>
  Promise.resolve()
    .then(() => accounts(pi))
    .then(rows => rows.filter(row => row.provider === provider))
    .then(rows => {
      const labels = rows.map(row => `${row.active ? "● " : "  "}${accountText(row, Date.now(), (_color, text) => text)} [${row.slug}]`);
      return Promise.resolve()
        .then(() => ctx.ui.select("CCS accounts · switches all clients following this provider", labels))
        .then(selected => rows[labels.indexOf(selected || "")]);
    })
    .then(account => {
      if (!account) return;
      return Promise.resolve()
        .then(() => ctx.ui.confirm("Switch CCS account?", `${account.email}\nThis also switches other clients following CCS.\nCCS will check current limits before switching.`))
        .then(confirmed => {
          if (!confirmed) return;
          return command(pi, ["use", account.slug]).then(text => ctx.ui.notify(text, "info"));
        });
    });

// ── Extension lifecycle ─────────────────────────────────────────

export default (pi: ExtensionAPI): void => {
  installSubscription(pi);
  const border: AccountBorder = { set: () => {}, dispose: () => {} };
  const lifetime = new AbortController();
  const timers = new Set<ReturnType<typeof setInterval>>();

  routes.forEach(route => {
    pi.registerProvider(route.provider, {
      baseUrl: route.baseUrl,
      apiKey: `!ccs serve --key ${route.accountProvider}`,
    });
  });

  pi.on("session_start", (_event, ctx) => Promise.resolve()
    .then(() => connect(pi, ctx, lifetime.signal))
    .then(() => {
      if (!ctx.hasUI) return;
      border.dispose();
      Object.assign(border, installAccountBorder());
      ctx.ui.setWidget("ccs", undefined);
      // Match the existing Claude status line's ten-second cache redraw.
      const timer = setInterval(() => { void refresh(pi, ctx, lifetime.signal, border); }, 10_000);
      timer.unref();
      timers.add(timer);
      return refresh(pi, ctx, lifetime.signal, border);
    }));

  pi.on("model_select", (_event, ctx) => {
    ctx.ui.setStatus("ccs-response", undefined);
    return refresh(pi, ctx, lifetime.signal, border);
  });
  pi.on("after_provider_response", (event, ctx) => {
    if (!providerFor(ctx.model?.provider)) return;
    const overage = event.headers["anthropic-ratelimit-unified-overage-in-use"] === "true";
    if (overage) {
      ctx.ui.setStatus("ccs-response", ctx.ui.theme.fg("warning", "CCS · extra usage"));
      ctx.ui.notify("Claude reports this request is using extra usage.", "warning");
      return;
    }
    if (event.status >= 400) {
      ctx.ui.setStatus("ccs-response", ctx.ui.theme.fg("error", `CCS · HTTP ${event.status}`));
      return;
    }
    ctx.ui.setStatus("ccs-response", undefined);
  });
  pi.on("agent_end", (_event, ctx) => refresh(pi, ctx, lifetime.signal, border));
  pi.on("before_agent_start", (_event, ctx) => {
    const provider = providerFor(ctx.model?.provider);
    if (!provider) return;
    return Promise.resolve()
      .then(() => activeAccount(pi, provider, lifetime.signal))
      .then(account => {
        if (!account) return;
        return { message: {
          customType: "ccs-account",
          content: `CCS routes this turn through ${account.email} (${account.plan}). Switching CCS accounts affects this session's next request and may make its prompt cache cold.\n${accountText(account, Date.now(), (_color, text) => text)}`,
          display: false,
        } };
      })
      .catch(error => {
        ctx.ui.notify(`CCS account reading failed: ${String(error)}`, "error");
      });
  });
  pi.on("session_shutdown", () => {
    border.dispose();
    lifetime.abort();
    timers.forEach(clearInterval);
    timers.clear();
  });

  pi.registerCommand("ccs", {
    description: "CCS account picker; /ccs refresh polls usage; /ccs status shows cached status",
    handler: (args, ctx) => Promise.resolve()
      .then(() => {
        const provider = providerFor(ctx.model?.provider);
        if (!provider) throw new Error("Choose an Anthropic or OpenAI Codex model to use CCS.");
        switch (args.trim()) {
          case "": return chooseAccount(pi, ctx, provider);
          case "refresh": return command(pi, ["status", `--${provider}`, "--json"]).then(() => undefined);
          case "status": return command(pi, ["status", `--${provider}`, "--cached"]).then(text => ctx.ui.notify(text, "info"));
          default: throw new Error("Use /ccs, /ccs refresh, or /ccs status.");
        }
      })
      .then(() => refresh(pi, ctx, lifetime.signal, border))
      .catch(error => { ctx.ui.notify(String(error), "error"); }),
  });
};
