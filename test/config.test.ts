import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";

test("loadConfig rejects a missing Hermes API key", () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => error instanceof ConfigError && error.message === "HERMES_API_KEY is required",
  );
});

test("loadConfig rejects a non-loopback Hermes API URL", () => {
  assert.throws(
    () => loadConfig({ HERMES_API_KEY: "x".repeat(32), HERMES_API_URL: "http://example.test:8642" }),
    (error: unknown) => error instanceof ConfigError && error.message === "HERMES_API_URL must use a loopback host",
  );
});

test("loadConfig does not treat a hostname beginning with 127 as loopback", () => {
  assert.throws(
    () => loadConfig({ HERMES_API_KEY: "x".repeat(32), HERMES_API_URL: "http://127.example.test:8642" }),
    (error: unknown) => error instanceof ConfigError && error.message === "HERMES_API_URL must use a loopback host",
  );
});

test("loadConfig rejects a too-short Hermes API key", () => {
  assert.throws(
    () => loadConfig({ HERMES_API_KEY: "short" }),
    (error: unknown) => error instanceof ConfigError && error.message === "HERMES_API_KEY must be at least 16 characters",
  );
});

test("loadConfig rejects non-HTTP Hermes URLs even on loopback", () => {
  assert.throws(
    () => loadConfig({ HERMES_API_KEY: "x".repeat(32), HERMES_API_URL: "ftp://127.0.0.1:8642" }),
    (error: unknown) => error instanceof ConfigError && error.message === "HERMES_API_URL must use http or https",
  );
});

test("loadConfig requires a literal loopback IP for the Hermes API", () => {
  assert.throws(
    () => loadConfig({ HERMES_API_KEY: "x".repeat(32), HERMES_API_URL: "http://localhost:8642" }),
    (error: unknown) =>
      error instanceof ConfigError
      && error.message === "HERMES_API_URL must use a literal loopback IP",
  );
});
