import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePublicOrigin, canonicalUrl, trustedCanonical } from "./public-origin.ts";
import { publicJson } from "./public-api.ts";

describe("trusted public origin handling", () => {
  it("uses the configured production origin instead of localhost or forwarded hosts", () => {
    const origin = resolvePublicOrigin({
      env: {
        APP_MODE: "production",
        BETTER_AUTH_URL: "https://engage.fusionparty.org.au",
      },
      requestUrl: "http://localhost:4321/proposals/",
    });
    assert.equal(origin, "https://engage.fusionparty.org.au");
  });

  it("prefers PUBLIC_ORIGIN and ignores an untrusted forwarded host", () => {
    const request = new Request("http://localhost:4402/proposals/", {
      headers: { "x-forwarded-host": "attacker.example" },
    });
    assert.equal(
      canonicalUrl("/proposals/", {
        env: {
          APP_MODE: "production",
          PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
          BETTER_AUTH_URL: "https://other.example",
        },
        requestUrl: request.url,
      }),
      "https://engage.fusionparty.org.au/proposals/",
    );
    assert.equal(
      resolvePublicOrigin({
        env: { APP_MODE: "production" },
        requestUrl: request.url,
      }),
      "http://localhost:4402",
      "without configuration the origin is still the request origin, never the forwarded host",
    );
  });

  it("keeps local development on the local origin", () => {
    assert.equal(
      resolvePublicOrigin({
        env: {
          APP_MODE: "development",
          BETTER_AUTH_URL: "http://localhost:4321",
        },
        requestUrl: "http://localhost:4321/",
        development: true,
      }),
      "http://localhost:4321",
    );
  });

  it("does not accept an http configured origin in production", () => {
    assert.equal(
      resolvePublicOrigin({
        env: {
          APP_MODE: "production",
          PUBLIC_ORIGIN: "http://insecure.example",
        },
        requestUrl: "https://engage.fusionparty.org.au/",
      }),
      "https://engage.fusionparty.org.au",
    );
  });

  it("rebuilds an absolute canonical input against the trusted origin", () => {
    assert.equal(
      trustedCanonical("http://localhost:4321/proposals/POL-010/", {
        env: {
          APP_MODE: "production",
          PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
        },
        requestUrl: "http://localhost:4321/",
      }),
      "https://engage.fusionparty.org.au/proposals/POL-010/",
    );
  });

  it("writes the trusted origin into public API Link headers", async () => {
    const response = await publicJson(
      new Request("http://localhost:4402/api/v1/policies", {
        headers: { host: "attacker.example" },
      }),
      { data: [] },
      {
        env: {
          APP_MODE: "production",
          PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
        },
      },
    );
    assert.equal(
      response.headers.get("link"),
      '<https://engage.fusionparty.org.au/api/v1/policies>; rel="canonical"',
    );
  });
});
