// Lifecycle fixtures verify outgoing normalization and incoming execution names
// with no provider calls. Independent registrations stand in for SDK subagents.
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { usesClaudeGateway } from "./subscription.ts";
import installSubscriptionGuard from "./vendor/subscription-guard.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: any, ctx: ExtensionContext) => any;

const fixture = () => {
  const tools = new Map<string, Tool>();
  const active = { names: [] as string[] };
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const register = (name: string): void => {
    tools.set(name, {
      name, label: name, description: `Fixture ${name}`,
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: async () => { calls.push(name); return { content: [{ type: "text", text: name }], details: {} }; },
    } as Tool);
    active.names.push(name);
  };
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => active.names,
    setActiveTools: (names: string[]) => { active.names = names; },
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); active.names.push(tool.name); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp", model: { provider: "anthropic", baseUrl: "http://127.0.0.1:4141" },
    modelRegistry: { isUsingOAuth: () => false },
  } as unknown as ExtensionContext;
  const guard = installSubscriptionGuard(api, usesClaudeGateway);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  return { ctx, guard, emit, register, tools, calls, active };
};

test("CCS normalizes tools, prompt, history and forced choice without a saved OAuth login", async () => {
  const f = fixture();
  ["read", "lsp_definition", "mcp__existing__search"].forEach(f.register);
  await f.emit("session_start");
  await f.emit("before_agent_start");
  const alias = f.guard.FLAT_TO_MCP.get("lsp_definition")!;
  assert.match(alias, /^mcp__/);
  const payload = {
    system: [{ type: "text", text: "pi itself reads pi .md files and pi packages", cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "read", input_schema: {} },
      { name: "lsp_definition", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "mcp__existing__search", input_schema: {} },
      { name: "web_search", type: "web_search_20250305" },
    ],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "lsp_definition", input: { query: "Symbol" } }] }],
    tool_choice: { type: "tool", name: "lsp_definition" },
  };
  const original = structuredClone(payload);
  const transformed = f.emit("before_provider_request", { payload });
  assert.equal(transformed.system[0].text, "the cli itself reads cli .md files and cli packages");
  assert.deepEqual(transformed.system[0].cache_control, payload.system[0].cache_control);
  assert.deepEqual(transformed.tools.map((tool: { name: string }) => tool.name), ["read", alias, "mcp__existing__search", "web_search"]);
  assert.deepEqual(transformed.tools[1].input_schema, payload.tools[1].input_schema);
  assert.equal(transformed.messages[0].content[0].name, alias);
  assert.equal(transformed.tool_choice.name, alias);
  assert.deepEqual(payload, original);

  const message = { role: "assistant", content: [{ type: "toolCall", name: alias, id: "a", arguments: { query: "Symbol" } }] };
  const returned = await f.emit("message_end", { message });
  const call = returned.message.content[0];
  assert.equal(call.name, "lsp_definition");
  await f.tools.get(call.name)!.execute(call.id, call.arguments, undefined, undefined, f.ctx);
  assert.deepEqual(f.calls, ["lsp_definition"]);
  assert.equal(message.content[0].name, alias);
});

test("Codex and direct Anthropic do not receive normalization or automatic aliases", async () => {
  for (const model of [
    { provider: "openai-codex", baseUrl: "http://127.0.0.1:4141/backend-api" },
    { provider: "anthropic", baseUrl: "https://api.anthropic.com" },
  ]) {
    const f = fixture();
    f.ctx.model = model as ExtensionContext["model"];
    f.register("custom_tool");
    await f.emit("session_start");
    await f.emit("before_agent_start");
    assert.deepEqual(f.active.names, ["custom_tool"]);
    assert.equal(f.emit("before_provider_request", { payload: { system: "pi itself" } }), undefined);
  }
});

test("late tools, name collisions, source updates and model switches retain correct routing", async () => {
  const f = fixture();
  f.register("custom_tool");
  f.register("mcp__pi__custom_tool");
  await f.emit("before_agent_start");
  assert.equal(f.guard.FLAT_TO_MCP.get("custom_tool"), "mcp__pi__custom_tool_2");
  f.register("late_tool");
  const transformed = f.emit("before_provider_request", { payload: { tools: [{ name: "late_tool", input_schema: { type: "object" } }] } });
  assert.equal(transformed.tools[0].name, "mcp__pi__late_tool");
  assert.equal(f.tools.get("mcp__pi__late_tool")?.description, "Fixture late_tool");
  f.tools.get("late_tool")!.description = "Updated schema description";
  await f.emit("before_agent_start");
  assert.equal(f.tools.get("mcp__pi__late_tool")?.description, "Updated schema description");
  f.ctx.model = { provider: "openai-codex" } as ExtensionContext["model"];
  await f.emit("before_agent_start");
  assert.deepEqual(f.active.names, ["custom_tool", "mcp__pi__custom_tool", "late_tool"]);
});

test("two sessions own independent alias routes and source tools", async () => {
  const first = fixture();
  const second = fixture();
  first.register("first_tool");
  second.register("second_tool");
  await Promise.all([first.emit("session_start"), second.emit("session_start")]);
  assert.equal(first.guard.FLAT_TO_MCP.has("second_tool"), false);
  assert.equal(second.guard.FLAT_TO_MCP.has("first_tool"), false);
  assert.equal(second.guard.unaliasToolCalls({ role: "assistant", content: [{ type: "toolCall", name: "mcp__pi__first_tool" }] }), undefined);
});
