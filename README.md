# Slint UI Testing auth

Authenticates [uv](https://docs.astral.sh/uv/) to the Slint UI Testing package
index (`https://testing.slint.dev/simple/`) from GitHub Actions, without a
stored secret.

The action exchanges the job's GitHub OIDC token for a short-lived Slint token
and exports it as the index credentials uv reads. This works like PyPI's trusted
publishing: the repository is registered once, and there is no token to create,
store or rotate.

## Usage

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # lets the job request its GitHub OIDC token
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v7
      - uses: slint-ui/ui-testing-auth@v1
      - run: uv sync
```

`pyproject.toml` names the index the same as the action's `index-name`:

```toml
[[tool.uv.index]]
name = "slint-private"
url = "https://testing.slint.dev/simple/"
explicit = true

[tool.uv.sources]
slint-testing = { index = "slint-private" }
```

### Setup

Register the repository on your UI testing page in the Slint account, under CI
repositories (`owner/repo`). Your seat needs the UI testing add-on, and the
token then carries its UI testing entitlement. Anyone else with UI testing may
register the same repository too; a run works while any of them still has it.

The first run records GitHub's id for the repository. From then on a renamed or
transferred repository keeps working; one deleted and re-created under the same
name doesn't, so remove its registration and add it again.

Slint can also register a repository for your organization; the token then
carries your organization's entitlements.

### Inputs

| Input         | Default                     | Description                                                                                         |
| ------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `index-name`  | `slint-private`             | The `[[tool.uv.index]]` name. The action exports `UV_INDEX_<NAME>_USERNAME` and `_PASSWORD` for it. |
| `account-url` | `https://account.slint.dev` | The Slint account that issues the token.                                                            |
| `audience`    | `https://testing.slint.dev` | The service the token is for.                                                                       |

### Outputs

| Output  | Description                                                     |
| ------- | --------------------------------------------------------------- |
| `token` | The short-lived token, for tools other than uv. Masked in logs. |

## Notes

- The token is valid for an hour, and only for `testing.slint.dev`. Run the
  action right before the uv step that installs from the index. In a job that
  runs uv again more than an hour later, run the action again before it.
- Pull requests from forks don't get an OIDC token, just as they don't get
  secrets. For repositories Slint has enabled this for, the action gets the
  token another way there, see below; elsewhere the step fails.
- The action has no dependencies and runs on Linux, macOS and Windows runners.
  It runs its script with the runner's `node`, which GitHub-hosted runners have;
  a self-hosted runner needs Node.js 20 or later on the `PATH`.

## How it works

1. The job asks GitHub for an OIDC token whose audience is the Slint account.
2. The action sends it to `POST <account-url>/api/auth/ci-token?resource=<audience>`.
   The account checks it against GitHub's published keys, then looks up the
   repository: registered by Slint for an organization, the token lists that
   organization's entitlements; registered on a UI testing page, it carries the
   UI testing entitlement of a seat that registered it. The token is signed by
   the account.
3. uv sends that token as the index password. `testing.slint.dev` checks it
   against the account's published keys.

In a pull request from a fork, GitHub gives the job no OIDC token. There, for
repositories Slint has enabled it for:

1. The action makes a key pair and uploads the public key as an artifact
   `ui-testing-token-key-<uuid>` of the job's own run.
2. It sends the run's id and attempt and the artifact's name to
   `POST <account-url>/api/auth/ci-token/fork-pr?resource=<audience>`.
3. The account checks with GitHub that this run is a running pull request
   from a fork of the repository, and that it uploaded that key. It answers
   with the token encrypted to the key, so only this job can read it, although
   anyone can read the artifact. The token carries the UI testing entitlement.
4. The action decrypts it, deletes the private key, and hands the token to uv.
