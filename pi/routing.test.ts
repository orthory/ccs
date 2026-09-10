// Exercise saved credentials through Pi's real authentication and transports.
// A local HTTP server observes the final wire headers; no provider is contacted.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { gatewayProvider } from "./routing.ts";

// ── Saved-login regression ─────────────────────────────────────

const jwt = (account: string) => [
  Buffer.from('{"alg":"none"}').toString("base64url"),
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url"),
  "fixture",
].join(".");

for (const provider of ["anthropic", "openai-codex"]) {
  for (const credentialType of ["oauth", "api_key", "absent"]) {
    test(`${provider} transport uses CCS with ${credentialType} credentials`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "ccs-pi-auth-"));
      const requests: { authorization: string | undefined; account: string | string[] | undefined }[] = [];
      const server = createServer((request, response) => {
        requests.push({ authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"] });
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture completed" } }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const gatewayKey = provider === "anthropic" ? "sk-ant-oat-ccs-fixture" : jwt("ccs");
      const savedKey = provider === "anthropic" ? "sk-ant-oat-saved-fixture" : jwt("saved-account");
      const authPath = join(directory, "auth.json");
      const credentials = (() => {
        switch (credentialType) {
          case "oauth": return { [provider]: { type: "oauth", access: savedKey, refresh: "unused", expires: Date.now() + 86_400_000 } };
          case "api_key": return { [provider]: { type: "api_key", key: savedKey } };
          default: return {};
        }
      })();
      const stored = JSON.stringify(credentials);
      await writeFile(authPath, stored);
      await Promise.resolve()
        .then(() => ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false }))
        .then(async runtime => {
          const base = runtime.getProvider(provider);
          assert.ok(base);
          runtime.registerNativeProvider(gatewayProvider(base, baseUrl, gatewayKey));
          const auth = await runtime.getAuth(provider);
          assert.equal(auth?.auth.apiKey, gatewayKey);
          assert.equal(auth?.auth.baseUrl, baseUrl);
          const model = runtime.getModels(provider)[0];
          assert.ok(model);
          const result = await runtime.completeSimple(model, {
            messages: [{ role: "user", content: "fixture", timestamp: Date.now() }],
          }, { transport: "sse" });
          assert.equal(result.stopReason, "error");
          assert.match(result.errorMessage || "", /fixture completed/);
          assert.equal(requests.length, 1);
          assert.equal(requests[0].authorization, `Bearer ${gatewayKey}`);
          if (provider === "openai-codex") assert.equal(requests[0].account, "ccs");
          assert.equal(await readFile(authPath, "utf8"), stored);
        })
        .finally(async () => {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await rm(directory, { recursive: true });
        });
    });
  }
}
