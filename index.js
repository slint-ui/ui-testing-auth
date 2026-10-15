// Exchanges this job's GitHub Actions OIDC token for a short-lived Slint
// entitlement token, and hands that to uv as the index password. Dependency
// free, so there is nothing to build or bundle.

"use strict";

const fs = require("node:fs");

const RETRIES = 3;
// Overridden by the tests.
const timing = { retryDelayMs: 1000 };

function input(name, fallback) {
  const value = process.env[`INPUT_${name.toUpperCase()}`];
  return value && value.trim() ? value.trim() : fallback;
}

// uv reads an index's credentials from UV_INDEX_<NAME>_USERNAME/_PASSWORD,
// with the name upper-cased and anything else than letters and digits as `_`.
function uvEnvPrefix(indexName) {
  return `UV_INDEX_${indexName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

async function withRetries(what, attempt) {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (!e.retryable || i >= RETRIES) throw e;
      console.log(`${what} failed (${e.message}), retrying…`);
      await new Promise((r) => setTimeout(r, timing.retryDelayMs * 2 ** i));
    }
  }
}

function failure(message, retryable = false) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}

async function githubOidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw failure(
      "No GitHub OIDC token available. Add `permissions: id-token: write` to the job. " +
        "Pull requests from forks never get one.",
    );
  }
  const u = new URL(url);
  u.searchParams.set("audience", audience);
  return withRetries("Requesting the GitHub OIDC token", async () => {
    let r;
    try {
      r = await fetch(u, { headers: { authorization: `Bearer ${bearer}` } });
    } catch (e) {
      throw failure(e.message, true);
    }
    if (!r.ok) {
      throw failure(`GitHub answered ${r.status} for the OIDC token`, r.status >= 500);
    }
    const { value } = await r.json();
    if (typeof value !== "string" || !value) throw failure("GitHub returned no OIDC token");
    return value;
  });
}

const EXPLAIN = {
  400: "the account does not issue tokens for this audience",
  401: "the account did not accept the GitHub OIDC token",
  403:
    "this repository is not registered: add it under CI repositories on your " +
    "UI testing page in the Slint account (with a seat that includes UI testing)",
  404: "the account does not issue CI tokens (feature off)",
};

async function entitlementToken(accountUrl, audience, oidcToken) {
  const u = new URL("/api/auth/ci-token", accountUrl);
  u.searchParams.set("resource", audience);
  return withRetries("Requesting the Slint token", async () => {
    let r;
    try {
      r = await fetch(u, {
        method: "POST",
        headers: { authorization: `Bearer ${oidcToken}` },
        redirect: "manual",
      });
    } catch (e) {
      throw failure(e.message, true);
    }
    if (r.status >= 300 && r.status < 400) {
      throw failure(`${u} redirected to ${r.headers.get("location")} (is it behind a login?)`);
    }
    if (!r.ok) {
      const why = EXPLAIN[r.status] ?? "unexpected response";
      throw failure(`${u} answered ${r.status}: ${why}`, r.status >= 500);
    }
    const { token } = await r.json();
    if (typeof token !== "string" || !token) throw failure(`${u} returned no token`);
    return token;
  });
}

function exportVariable(name, value) {
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function setOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const accountUrl = trimSlash(input("account-url", "https://account.slint.dev"));
  const audience = trimSlash(input("audience", "https://testing.slint.dev"));
  const prefix = uvEnvPrefix(input("index-name", "slint-private"));

  // The GitHub token names the account as its audience, so it can't be
  // replayed against anything else.
  const oidcToken = await githubOidcToken(accountUrl);
  const token = await entitlementToken(accountUrl, audience, oidcToken);

  console.log(`::add-mask::${token}`);
  exportVariable(`${prefix}_USERNAME`, "__token__");
  exportVariable(`${prefix}_PASSWORD`, token);
  setOutput("token", token);
  console.log(`Exported ${prefix}_USERNAME and ${prefix}_PASSWORD for uv.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { uvEnvPrefix, githubOidcToken, entitlementToken, main, timing };
