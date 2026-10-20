// Gets a short-lived Slint entitlement token for this job and hands it to uv
// as the index password. Dependency free, so there is nothing to build or
// bundle. action.yml runs it in two steps around an artifact upload:
//
// - `prepare`: with a GitHub OIDC token, exchanges it and is done. In a pull
//   request from a fork, which GitHub gives no OIDC token, it makes a key pair
//   instead and writes the public key for action.yml to upload as an artifact.
// - `exchange`: asks the account for a token for this run, which the account
//   checks with GitHub, and decrypts the answer with the private key.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RETRIES = 3;
// Overridden by the tests.
const timing = { retryDelayMs: 1000 };

function input(name, fallback) {
  const value = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
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

const FORK_PR_EXPLAIN = {
  400: "the account does not issue tokens for this audience",
  403:
    "the account does not issue tokens to pull requests from forks of this " +
    "repository, or GitHub did not confirm this run",
  404: "the account does not issue tokens to pull requests from forks (feature off)",
  429: "too many token requests for this run or repository",
};

// The key artifact may take a moment to show up in GitHub's API after the
// upload, so a 403 is retried too.
async function forkPrToken(accountUrl, audience, request) {
  const u = new URL("/api/auth/ci-token/fork-pr", accountUrl);
  u.searchParams.set("resource", audience);
  return withRetries("Requesting the Slint token", async () => {
    let r;
    try {
      r = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "manual",
      });
    } catch (e) {
      throw failure(e.message, true);
    }
    if (r.status >= 300 && r.status < 400) {
      throw failure(`${u} redirected to ${r.headers.get("location")} (is it behind a login?)`);
    }
    if (!r.ok) {
      const why = FORK_PR_EXPLAIN[r.status] ?? "unexpected response";
      throw failure(`${u} answered ${r.status}: ${why}`, r.status >= 500 || r.status === 403);
    }
    const { encrypted_token } = await r.json();
    if (typeof encrypted_token !== "string" || !encrypted_token) {
      throw failure(`${u} returned no token`);
    }
    return encrypted_token;
  });
}

function base64url(text) {
  return Buffer.from(text, "base64url");
}

// A compact JWE with RSA-OAEP-256 key encryption and A256GCM content
// encryption, the one kind the account sends.
async function decryptJwe(jwe, privateJwk) {
  const parts = jwe.split(".");
  if (parts.length !== 5) throw failure("the account's answer is no JWE");
  const [header, encryptedKey, iv, ciphertext, tag] = parts;
  const { alg, enc } = JSON.parse(base64url(header).toString());
  if (alg !== "RSA-OAEP-256" || enc !== "A256GCM") {
    throw failure(`the account's answer uses ${alg}/${enc}, not RSA-OAEP-256/A256GCM`);
  }
  const subtle = globalThis.crypto.subtle;
  const privateKey = await subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const cek = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, base64url(encryptedKey));
  const aesKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: base64url(iv), additionalData: Buffer.from(header, "ascii") },
    aesKey,
    Buffer.concat([base64url(ciphertext), base64url(tag)]),
  );
  return Buffer.from(plaintext).toString();
}

function isForkPullRequest() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !process.env.GITHUB_EVENT_PATH) {
    return false;
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const head = event.pull_request?.head?.repo?.full_name;
  return Boolean(head) && head !== process.env.GITHUB_REPOSITORY;
}

function exportVariable(name, value) {
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function setOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function settings() {
  return {
    accountUrl: trimSlash(input("account-url", "https://account.slint.dev")),
    audience: trimSlash(input("audience", "https://testing.slint.dev")),
    prefix: uvEnvPrefix(input("index-name", "slint-private")),
  };
}

function deliver(token, prefix) {
  console.log(`::add-mask::${token}`);
  exportVariable(`${prefix}_USERNAME`, "__token__");
  exportVariable(`${prefix}_PASSWORD`, token);
  setOutput("token", token);
  console.log(`Exported ${prefix}_USERNAME and ${prefix}_PASSWORD for uv.`);
}

async function prepare() {
  const { accountUrl, audience, prefix } = settings();
  const hasOidc = process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (hasOidc || !isForkPullRequest()) {
    // The GitHub token names the account as its audience, so it can't be
    // replayed against anything else.
    const oidcToken = await githubOidcToken(accountUrl);
    deliver(await entitlementToken(accountUrl, audience, oidcToken), prefix);
    setOutput("mode", "done");
    return;
  }

  const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const { kty, n, e } = await globalThis.crypto.subtle.exportKey("jwk", publicKey);
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "ui-testing-auth-"));
  fs.writeFileSync(path.join(dir, "key.json"), JSON.stringify({ kty, n, e }));
  const privateKeyFile = path.join(dir, "private.json");
  fs.writeFileSync(
    privateKeyFile,
    JSON.stringify(await globalThis.crypto.subtle.exportKey("jwk", privateKey)),
    { mode: 0o600 },
  );
  setOutput("mode", "fork-pr");
  setOutput("artifact", `ui-testing-token-key-${globalThis.crypto.randomUUID()}`);
  setOutput("public-key", path.join(dir, "key.json"));
  setOutput("private-key", privateKeyFile);
  console.log("No GitHub OIDC token in a pull request from a fork: asking with this run's key instead.");
}

async function exchange() {
  const { accountUrl, audience, prefix } = settings();
  const privateKeyFile = process.env.PRIVATE_KEY_FILE;
  try {
    const encrypted = await forkPrToken(accountUrl, audience, {
      repository: process.env.GITHUB_REPOSITORY,
      run_id: Number(process.env.GITHUB_RUN_ID),
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      artifact: process.env.KEY_ARTIFACT,
    });
    const privateJwk = JSON.parse(fs.readFileSync(privateKeyFile, "utf8"));
    deliver(await decryptJwe(encrypted, privateJwk), prefix);
  } finally {
    fs.rmSync(path.dirname(privateKeyFile), { recursive: true, force: true });
  }
}

const COMMANDS = { prepare, exchange };

if (require.main === module) {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    console.log(`::error::Unknown command ${process.argv[2]}; expected prepare or exchange.`);
    process.exitCode = 1;
  }
  command?.().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { uvEnvPrefix, githubOidcToken, entitlementToken, prepare, exchange, timing };
