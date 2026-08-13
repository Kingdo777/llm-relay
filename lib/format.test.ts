import assert from "node:assert/strict";
import test from "node:test";
import { buildUpstreamUrl } from "./format";

test("accepts provider roots with or without a trailing v1", () => {
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com", "v1/chat/completions"),
    "https://yibuapi.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com/v1", "v1/chat/completions"),
    "https://yibuapi.com/v1/chat/completions",
  );
});
