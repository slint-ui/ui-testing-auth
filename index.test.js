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
      INPUT_ACCOUNT_URL: "https://account.example/",
      INPUT_AUDIENCE: "https://testing.example",
      INPUT_INDEX_NAME: "slint-private",
      RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: "slint-ui/slint",
      GITHUB_EVENT_NAME: "push",
    });
    routes["https://gh.example/token"] = () => Response.json({ value: "gh-oidc" });
    routes["https://account.example/api/auth/ci-token"] = () =>
      Response.json({ token: "eyJ.slint.token" });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports the token for uv, and is done", async () => {
    await action.prepare();
    assert.equal(
      fs.readFileSync(process.env.GITHUB_ENV, "utf8"),
      "UV_INDEX_SLINT_PRIVATE_USERNAME=__token__\n" +
        "UV_INDEX_SLINT_PRIVATE_PASSWORD=eyJ.slint.token\n",
    );
    assert.equal(
      fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"),
      "token=eyJ.slint.token\nmode=done\n",
    );
  });

  it("asks GitHub for a token naming the account, and the account for one naming the service", async () => {
    await action.prepare();
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
    await assert.rejects(action.prepare(), /id-token: write/);
  });

  it("explains an unregistered repository", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      Response.json({ error: "forbidden" }, { status: 403 });
    await assert.rejects(action.prepare(), /not registered/);
    assert.equal(calls.length, 2);
  });

  it("reports a login redirect instead of following it", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      new Response(null, { status: 302, headers: { location: "https://login.example/" } });
    await assert.rejects(action.prepare(), /redirected to https:\/\/login\.example\//);
  });

  it("retries a server error", async () => {
    let n = 0;
    routes["https://account.example/api/auth/ci-token"] = () =>
      ++n < 2
        ? new Response("busy", { status: 503 })
        : Response.json({ token: "eyJ.slint.token" });
    await action.prepare();
    assert.equal(n, 2);
  });

  it("gives up after three server errors", async () => {
    routes["https://account.example/api/auth/ci-token"] = () =>
      new Response("down", { status: 503 });
    await assert.rejects(action.prepare(), /503/);
    assert.equal(calls.length, 4);
  });

  it("sends a verification code as the verification_code form field", async () => {
    process.env.INPUT_VERIFICATION_CODE = "slv_abc";
    try {
      await action.prepare();
    } finally {
      delete process.env.INPUT_VERIFICATION_CODE;
    }
    const account = calls[1];
    assert.equal(account.init.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(account.init.body, "verification_code=slv_abc");
    assert.equal(account.init.headers.authorization, "Bearer gh-oidc");
  });

  it("sends no body without a verification code", async () => {
    await action.prepare();
    assert.equal(calls[1].init.body, undefined);
    assert.equal(calls[1].init.headers["content-type"], undefined);
  });

  describe("with an organization CI key", () => {
    beforeEach(() => {
      process.env.INPUT_CI_KEY = "slci_secret";
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    });

    afterEach(() => {
      delete process.env.INPUT_CI_KEY;
    });

    it("swaps the key, not an OIDC token, masks it, and exports the token", async () => {
      const logs = [];
      const log = console.log;
      console.log = (line) => logs.push(line);
      try {
        await action.prepare();
      } finally {
        console.log = log;
      }
      assert.equal(calls.length, 1);
      const [account] = calls;
      assert.equal(account.url.pathname, "/api/auth/ci-token");
      assert.equal(account.url.searchParams.get("resource"), "https://testing.example");
      assert.equal(account.init.headers.authorization, "Bearer slci_secret");
      assert.equal(account.init.body, undefined);
      assert.ok(logs.includes("::add-mask::slci_secret"));
      assert.match(
        fs.readFileSync(process.env.GITHUB_ENV, "utf8"),
        /UV_INDEX_SLINT_PRIVATE_PASSWORD=eyJ\.slint\.token\n/,
      );
      assert.match(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), /mode=done\n/);
    });

    it("explains a runner outside the key's ranges", async () => {
      routes["https://account.example/api/auth/ci-token"] = () =>
        Response.json({ error: "forbidden" }, { status: 403 });
      await assert.rejects(action.prepare(), /outside the CI key's IP ranges/);
    });

    it("uses the key in a pull request from a fork too, when it has one", async () => {
      process.env.GITHUB_EVENT_NAME = "pull_request";
      const event = path.join(dir, "event.json");
      fs.writeFileSync(
        event,
        JSON.stringify({ pull_request: { head: { repo: { full_name: "someone/slint" } } } }),
      );
      process.env.GITHUB_EVENT_PATH = event;
      try {
        await action.prepare();
      } finally {
        delete process.env.GITHUB_EVENT_PATH;
        process.env.GITHUB_EVENT_NAME = "push";
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.headers.authorization, "Bearer slci_secret");
    });
  });

  describe("in a pull request from a fork", () => {
    beforeEach(() => {
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      const eventPath = path.join(dir, "event.json");
      fs.writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { head: { repo: { full_name: "contributor/slint" } } } }),
      );
      Object.assign(process.env, {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "2",
      });
    });

    function outputs() {
      return Object.fromEntries(
        fs
          .readFileSync(process.env.GITHUB_OUTPUT, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
      );
    }

    // What the account does: encrypt to the public key the job uploaded.
    async function encryptTo(publicJwk, plaintext) {
      const subtle = globalThis.crypto.subtle;
      const header = Buffer.from(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" })).toString(
        "base64url",
      );
      const cek = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const rsa = await subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
        "encrypt",
      ]);
      const encryptedKey = Buffer.from(await subtle.encrypt({ name: "RSA-OAEP" }, rsa, cek));
      const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
      const sealed = Buffer.from(
        await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: Buffer.from(header, "ascii") },
          aes,
          Buffer.from(plaintext),
        ),
      );
      return [
        header,
        encryptedKey.toString("base64url"),
        Buffer.from(iv).toString("base64url"),
        sealed.subarray(0, -16).toString("base64url"),
        sealed.subarray(-16).toString("base64url"),
      ].join(".");
    }

    async function prepareAndExchange() {
      await action.prepare();
      const out = outputs();
      Object.assign(process.env, { KEY_ARTIFACT: out.artifact, PRIVATE_KEY_FILE: out["private-key"] });
      fs.writeFileSync(process.env.GITHUB_OUTPUT, "");
      await action.exchange();
      return out;
    }

    it("writes a public key for the artifact and keeps the private one", async () => {
      await action.prepare();
      const out = outputs();
      assert.equal(out.mode, "fork-pr");
      assert.match(out.artifact, /^ui-testing-token-key-[0-9a-f-]{36}$/);
      const publicJwk = JSON.parse(fs.readFileSync(out["public-key"], "utf8"));
      assert.deepEqual(Object.keys(publicJwk).sort(), ["e", "kty", "n"]);
      assert.equal(publicJwk.kty, "RSA");
      assert.ok(JSON.parse(fs.readFileSync(out["private-key"], "utf8")).d);
      assert.equal(calls.length, 0);
    });

    it("asks the account for this run, decrypts the answer and exports it", async () => {
      routes["https://account.example/api/auth/ci-token/fork-pr"] = async (_u, init) => {
        const body = JSON.parse(init.body);
        const publicJwk = JSON.parse(
          fs.readFileSync(path.join(path.dirname(process.env.PRIVATE_KEY_FILE), "key.json"), "utf8"),
        );
        assert.deepEqual(body, {
          repository: "slint-ui/slint",
          run_id: 1234,
          run_attempt: 2,
          artifact: process.env.KEY_ARTIFACT,
        });
        return Response.json({ encrypted_token: await encryptTo(publicJwk, "eyJ.fork.token") });
      };
      const out = await prepareAndExchange();
      assert.equal(calls.at(-1).url.searchParams.get("resource"), "https://testing.example");
      assert.equal(
        fs.readFileSync(process.env.GITHUB_ENV, "utf8"),
        "UV_INDEX_SLINT_PRIVATE_USERNAME=__token__\n" +
          "UV_INDEX_SLINT_PRIVATE_PASSWORD=eyJ.fork.token\n",
      );
      assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8"), "token=eyJ.fork.token\n");
      assert.equal(fs.existsSync(out["private-key"]), false);
    });

    it("retries a refusal, since the artifact may not be visible yet, then explains it", async () => {
      routes["https://account.example/api/auth/ci-token/fork-pr"] = () =>
        Response.json({ error: "forbidden" }, { status: 403 });
      await assert.rejects(prepareAndExchange(), /pull requests from forks of this repository/);
      assert.equal(calls.length, 3);
      assert.equal(fs.existsSync(process.env.PRIVATE_KEY_FILE), false);
    });

    it("still asks for an OIDC token outside a pull request from a fork", async () => {
      process.env.GITHUB_EVENT_NAME = "push";
      await assert.rejects(action.prepare(), /id-token: write/);
    });
  });
});
