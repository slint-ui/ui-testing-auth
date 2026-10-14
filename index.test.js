"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const action = require("./index.js");

action.timing.retryDelayMs = 0;

const realFetch = globalThis.fetch;
let calls;
let routes;

beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const handler = routes[`${u.origin}${u.pathname}`];
    if (!handler) throw new TypeError(`no route for ${u}`);
    return handler(u, init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("uvEnvPrefix", () => {
  it("follows uv's naming", () => {
    assert.equal(action.uvEnvPrefix("slint-private"), "UV_INDEX_SLINT_PRIVATE");
    assert.equal(action.uvEnvPrefix("my.index2"), "UV_INDEX_MY_INDEX2");
  });
});

describe("main", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-testing-auth-"));
    Object.assign(process.env, {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh.example/token?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-token",
      GITHUB_ENV: path.join(dir, "env"),
      GITHUB_OUTPUT: path.join(dir, "output"),
      "INPUT_ACCOUNT-URL": "https://account.example/",
      INPUT_AUDIENCE: "https://testing.example",
      "INPUT_INDEX-NAME": "slint-private",
    });
    routes["https://gh.example/token"] = () => Response.json({ value: "gh-oidc" });
    routes["https://account.example/api/auth/ci-token"] = () =>
      Response.json({ token: "eyJ.slint.token" });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports the token for uv", async () => {
    await action.main();
    assert.equal(
      fs.readFileSync(process.env.GITHUB_ENV, "utf8"),
      "UV_INDEX_SLINT_PRIVATE_USERNAME=__token__\n" +
        "UV_INDEX_SLINT_PRIVATE_PASSWORD=eyJ.slint.token\n",
    );
    assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), "token=eyJ.slint.token\n");
  });

  it("asks GitHub for a token naming the account, and the account for one naming the service", async () => {
    await action.main();
    const [gh, account] = calls;
    assert.equal(gh.url.searchParams.get("audience"), "https://account.example");
    assert.equal(gh.url.searchParams.get("api-version"), "2.0");
    assert.equal(gh.init.headers.authorization, "Bearer runtime-token");
    assert.equal(account.init.method, "POST");
    assert.equal(account.init.headers.authorization, "Bearer gh-oidc");
    assert.equal(account.url.searchParams.get("resource"), "https://testing.example");
  });

  it("explains a missing id-token permission", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    await assert.rejects(action.main(), /id-token: write/);
  });

  it("explains an unregistered repository", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      Response.json({ error: "forbidden" }, { status: 403 });
    await assert.rejects(action.main(), /not registered/);
    assert.equal(calls.length, 2);
  });

  it("reports a login redirect instead of following it", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      new Response(null, { status: 302, headers: { location: "https://login.example/" } });
    await assert.rejects(action.main(), /redirected to https:\/\/login\.example\//);
  });

  it("retries a server error", async () => {
    let n = 0;
    routes["https://account.example/api/auth/ci-token"] = () =>
      ++n < 2
        ? new Response("busy", { status: 503 })
        : Response.json({ token: "eyJ.slint.token" });
    await action.main();
    assert.equal(n, 2);
  });

  it("gives up after three server errors", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      new Response("down", { status: 503 });
    await assert.rejects(action.main(), /503/);
    assert.equal(calls.length, 4);
  });
});
