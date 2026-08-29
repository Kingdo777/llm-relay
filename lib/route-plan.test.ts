import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow, Protocol, RouteMode } from "./types";
import { isRoutedProtocol, resolveRoute } from "./route-plan";

const base = {
  name: "Route Test",
  openai_base_url: "https://openai.example",
  anthropic_base_url: "https://anthropic.example",
  app_id: "",
  is_code_agent: 0,
} as LlmRow;

const expected: Record<RouteMode, Record<Protocol, Protocol>> = {
  off: {
    openai: "openai",
    "openai-responses": "openai-responses",
    anthropic: "anthropic",
  },
  "anthropic-to-openai": {
    openai: "openai",
    "openai-responses": "openai-responses",
    anthropic: "openai",
  },
  "openai-to-anthropic": {
    openai: "anthropic",
    "openai-responses": "anthropic",
    anthropic: "anthropic",
  },
};

test("resolves the complete route mode matrix", () => {
  for (const routeMode of Object.keys(expected) as RouteMode[]) {
    for (const protocol of Object.keys(expected[routeMode]) as Protocol[]) {
      const resolved = resolveRoute({ ...base, route_mode: routeMode }, protocol);
      assert.ok("plan" in resolved);
      assert.equal(resolved.plan.backendProtocol, expected[routeMode][protocol]);
      assert.equal(
        resolved.plan.routed,
        expected[routeMode][protocol] !== protocol
      );
      assert.equal(
        isRoutedProtocol(routeMode, protocol),
        expected[routeMode][protocol] !== protocol
      );
    }
  }
});

test("allows CodeAgent A-to-O and rejects Anthropic backends", () => {
  const codeAgent = { ...base, app_id: "app", is_code_agent: 1 as const };
  const routed = resolveRoute(
    { ...codeAgent, route_mode: "anthropic-to-openai" },
    "anthropic"
  );
  assert.ok("plan" in routed);
  assert.equal(routed.plan.backendProtocol, "openai");

  const direct = resolveRoute({ ...codeAgent, route_mode: "off" }, "anthropic");
  assert.ok("error" in direct);
  const reverse = resolveRoute(
    { ...codeAgent, route_mode: "openai-to-anthropic" },
    "openai"
  );
  assert.ok("error" in reverse);

  const ordinaryWithAppIdRow = {
    ...base,
    app_id: "metadata-only",
    is_code_agent: 0 as const,
    route_mode: "openai-to-anthropic" as const,
  } as LlmRow;
  const ordinaryWithAppId = resolveRoute(ordinaryWithAppIdRow, "openai");
  assert.ok("plan" in ordinaryWithAppId);
  assert.equal(ordinaryWithAppId.plan.backendProtocol, "anthropic");
});

test("requires the selected target Base URL", () => {
  const resolved = resolveRoute(
    {
      ...base,
      route_mode: "anthropic-to-openai",
      openai_base_url: "",
    },
    "anthropic"
  );
  assert.deepEqual(resolved, {
    error: "LLM「Route Test」没有配置路由目标 OpenAI Base URL",
  });
});
