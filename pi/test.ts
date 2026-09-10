// Exercise the extension at its CLI and Pi boundaries without changing logins
// or consuming subscription quota. Fixtures contain no usable credentials.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activeAccount, command } from "./client.ts";
import { accountText, type Account } from "./display.ts";
import extension from "./index.ts";

// ── Fixtures ───────────────────────────────────────────────────

const now = Date.parse("2026-09-11T00:00:00Z");
const plain = (_color: string, text: string) => text;
const account: Account = {
  provider: "claude", slug: "test", email: "test@example.com", plan: "max20x", active: true,
  polled_at: "2026-09-10T23:59:00Z",
  limits: [
    { kind: "session", percent: 90, resets_at: "2026-09-11T01:00:00Z", scope: null },
    { kind: "weekly_scoped", percent: 45, resets_at: null, scope: { model: { display_name: "Fable" } } },
  ],
};

const fake = (execute: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>) => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | void>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const providers = new Map<string, unknown>();
  const pi = {
    exec: (_binary: string, args: string[]) => execute(args),
    on: (event: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(event, handler),
    registerProvider: (name: string, config: unknown) => providers.set(name, config),
    registerCommand: (name: string, spec: typeof commands extends Map<string, infer H> ? H : never) => commands.set(name, spec),
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, providers };
};

const okay = (stdout: string) => Promise.resolve({ stdout, stderr: "", code: 0 });

// ── Display semantics ──────────────────────────────────────────

test("shows account, scoped windows, countdowns and cache age", () => {
  const text = accountText(account, now, plain);
  assert.match(text, /test@example.com · max20x/);
  assert.match(text, /5h 90% ↺1h00m/);
  assert.match(text, /Fable 45%/);
  assert.match(text, /read 1m ago/);
});

test("elapsed cached windows are unknown, never zero or an old percentage", () => {
  const text = accountText(account, now + 3_600_000, plain);
  assert.match(text, /5h \? \(refresh\)/);
  assert.doesNotMatch(text, /90%|5h 0%/);
});

test("missing readings and backend model unavailability stay explicit", () => {
  const text = accountText({ ...account, limits: [], polled_at: null, error: "not polled yet",
    model_usage: { astra: { available: false, available_at: "2026-09-10T00:00:00Z", credits_would_enable: true } },
  }, now, plain);
  assert.match(text, /astra unavailable · credits unlock/);
  assert.match(text, /not polled/);
  assert.doesNotMatch(text, /0%/);
});

// ── CLI boundary ───────────────────────────────────────────────

test("cached active lookup never polls or reads credentials itself", async () => {
  const calls: string[][] = [];
  const { pi } = fake(args => { calls.push(args); return okay(JSON.stringify([account])); });
  assert.deepEqual(await activeAccount(pi, "claude"), account);
  assert.deepEqual(calls, [["ls", "--cached", "--json"]]);
});

test("absent pointer uses the gateway's live-account fallback", async () => {
  const calls: string[][] = [];
  const { pi } = fake(args => {
    calls.push(args);
    return okay(JSON.stringify(args[0] === "ls" ? [{ ...account, active: false }] : account));
  });
  assert.deepEqual(await activeAccount(pi, "claude"), account);
  assert.deepEqual(calls[1], ["status", "--claude", "--cached", "--json"]);
});

test("CLI failure is surfaced without treating stderr as valid usage", async () => {
  const { pi } = fake(() => Promise.resolve({ stdout: "", stderr: "gateway unavailable", code: 1 }));
  await assert.rejects(command(pi, ["ls"]), /gateway unavailable/);
});

// ── Pi integration ─────────────────────────────────────────────

test("gateway headers replace saved credentials; account changes reach next turn", async () => {
  const responses = [account, { ...account, slug: "next", email: "next@example.com" }];
  const { pi, handlers, providers } = fake(args => {
    if (args[0] === "serve") return okay(`test-key-${args[2]}`);
    return okay(JSON.stringify([responses.shift()]));
  });
  const ctx = {
    hasUI: false, model: { provider: "anthropic" },
    ui: { notify: (message: string) => assert.fail(message) },
  } as unknown as ExtensionContext;
  extension(pi);
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual(providers.get("anthropic"), { baseUrl: "http://127.0.0.1:4141", apiKey: "!ccs serve --key claude" });
  assert.deepEqual(providers.get("openai-codex"), { baseUrl: "http://127.0.0.1:4141/backend-api", apiKey: "!ccs serve --key codex" });
  const headers = { authorization: "Bearer saved-login", "X-Api-Key": "saved-key", "anthropic-beta": "oauth", Authorization: "saved" };
  await handlers.get("before_provider_headers")!({ headers }, ctx);
  assert.equal(headers.Authorization, "Bearer test-key-claude");
  assert.equal(headers.authorization, null);
  assert.equal(headers["X-Api-Key"], null);
  assert.equal(headers["anthropic-beta"], "oauth");
  const first = await handlers.get("before_agent_start")!({}, ctx);
  const second = await handlers.get("before_agent_start")!({}, ctx);
  assert.match(JSON.stringify(first), /test@example.com/);
  assert.match(JSON.stringify(second), /next@example.com/);
  await handlers.get("session_shutdown")!({}, ctx);
});

test("picker cancellation performs no switch", async () => {
  const calls: string[][] = [];
  const { pi, commands } = fake(args => { calls.push(args); return okay(JSON.stringify([account])); });
  const ctx = {
    model: { provider: "anthropic" },
    ui: { select: () => undefined, setWidget: () => {}, theme: { fg: plain }, notify: () => {} },
  } as unknown as ExtensionContext;
  extension(pi);
  await commands.get("ccs")!.handler("", ctx);
  assert.ok(calls.every(args => args[0] === "ls"));
});

test("confirmed picker passes the exact slug, without force", async () => {
  const calls: string[][] = [];
  const { pi, commands } = fake(args => {
    calls.push(args);
    return okay(args[0] === "use" ? "switched" : JSON.stringify([account]));
  });
  const ctx = {
    model: { provider: "anthropic" },
    ui: { select: (_title: string, rows: string[]) => rows[0], confirm: () => true,
      setWidget: () => {}, theme: { fg: plain }, notify: () => {} },
  } as unknown as ExtensionContext;
  extension(pi);
  await commands.get("ccs")!.handler("", ctx);
  assert.deepEqual(calls.find(args => args[0] === "use"), ["use", "test"]);
});

test("gateway usage alerts preserve overage and HTTP failures; healthy response clears them", async () => {
  const { pi, handlers } = fake(() => okay(""));
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const ctx = {
    model: { provider: "anthropic" },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      theme: { fg: plain }, notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionContext;
  extension(pi);
  await handlers.get("after_provider_response")!({ status: 200, headers: { "anthropic-ratelimit-unified-overage-in-use": "true" } }, ctx);
  await handlers.get("after_provider_response")!({ status: 400, headers: {} }, ctx);
  await handlers.get("after_provider_response")!({ status: 200, headers: {} }, ctx);
  assert.deepEqual(statuses, ["CCS · extra usage", "CCS · HTTP 400", undefined]);
  assert.equal(notices.length, 1);
});
