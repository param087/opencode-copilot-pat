# opencode-copilot-pat

Use GitHub Copilot inside [OpenCode](https://opencode.ai) with a **fine-grained
personal access token** instead of the interactive device login.

The plugin adds a provider called `copilot-pat`. It sends your token straight to
the Copilot API with the Copilot CLI integration id, which is the only way GitHub
accepts personal access tokens there. It sits next to OpenCode's built-in
`github-copilot` provider, so an existing OAuth login keeps working and you can
run two Copilot accounts side by side and pick either per model.

Verified 2026-09-02 with OpenCode 1.3.17 on macOS. The plugin is plain
TypeScript with no dependencies, so it should work anywhere OpenCode runs.

## Contents

| file | purpose |
| --- | --- |
| `copilot-pat.ts` | the plugin; goes into OpenCode's `plugin/` folder |
| `install.sh` | macOS/Linux installer: copies the plugin, stores the token, runs a test |
| `opencode.example.jsonc` | the two config lines that make it the default model |

## Prerequisites

- OpenCode 1.3 or newer on `PATH` (`opencode --version`).
- A GitHub account with Copilot (Free, Pro, Pro+, Business or Enterprise).
- For `install.sh`: bash and python3. Windows users follow the manual steps.

## Step 1: create the token (once per GitHub account)

1. Sign in to GitHub as the account that has Copilot and open
   <https://github.com/settings/personal-access-tokens/new>.
2. **Token name:** anything, e.g. `opencode-copilot-pat`. Choose an expiration.
3. **Resource owner:** your personal account. Organisation-owned tokens cannot
   carry the permission below.
4. **Repository access:** leave "Public repositories".
5. **Permissions → Account permissions → Add permissions → Copilot Requests.**
   Read-only is its only level. Add nothing else.
6. **Generate token**, confirm, and copy the `github_pat_…` value. GitHub shows
   it once.

Only fine-grained tokens work. Classic tokens (`ghp_…`) are rejected by GitHub
on every Copilot endpoint with "Personal Access Tokens are not supported", even
when they have the `copilot` scope.

## Step 2: install the plugin

### macOS / Linux (scripted)

```sh
git clone https://github.com/param087/opencode-copilot-pat.git
cd opencode-copilot-pat
./install.sh                      # prompts for the token, input hidden
# or non-interactive:
COPILOT_PAT=github_pat_… ./install.sh
```

The script copies `copilot-pat.ts` to `~/.config/opencode/plugin/`, backs up
`~/.local/share/opencode/auth.json`, adds the `copilot-pat` entry, and sends one
test request through `copilot-pat/gpt-4.1`. It ends with `OK: PONG` when
everything is wired.

### Any OS, manual (this is all the script does)

1. Copy `copilot-pat.ts` into OpenCode's plugin folder:

   | OS | folder |
   | --- | --- |
   | macOS / Linux | `~/.config/opencode/plugin/` |
   | Windows | `%USERPROFILE%\.config\opencode\plugin\` |

   Create the `plugin` folder if it does not exist. OpenCode loads every
   `.ts`/`.js` file in it on startup, nothing else to register.

2. Store the token. Either

   ```sh
   opencode auth login
   ```

   choose **Other**, type `copilot-pat` as the provider id, and paste the
   token, or add this entry by hand to the auth file
   (`~/.local/share/opencode/auth.json`, on Windows
   `%USERPROFILE%\.local\share\opencode\auth.json`):

   ```json
   "copilot-pat": { "type": "api", "key": "github_pat_…" }
   ```

   Keep the other entries in that file as they are.

3. Restart OpenCode.

## Step 3: verify and use

```sh
opencode models | grep ^copilot-pat/                 # models your account can use
opencode run -m copilot-pat/gpt-4.1 "Reply with exactly: PONG" </dev/null
opencode -m copilot-pat/gpt-4.1                      # interactive session
```

Inside the TUI, `ctrl+t` (or the model picker) lists the `copilot-pat/…`
models next to your other providers.

### Make it the default

Add the two lines from `opencode.example.jsonc` to your OpenCode config
(`~/.config/opencode/opencode.json` or `.jsonc`):

```jsonc
"model": "copilot-pat/gpt-4.1",
"small_model": "copilot-pat/gpt-4.1"
```

Set `small_model` too, otherwise title generation keeps using whichever
provider it used before.

## Which models work

At startup the plugin asks the Copilot API which models your account has and
hides the ones whose policy is still "disabled". Those need a one-time enable
in the VS Code model picker or in GitHub Copilot settings, which accepts that
model's terms. After enabling, restart OpenCode and they appear.

What actually answers depends on the plan:

- **Copilot Free** (tested): `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`. Other listed
  models, including Claude Haiku 4.5, answer `model_not_supported` on this
  integration even when enabled.
- **Paid plans** (Pro, Pro+, Business, Enterprise): the Copilot CLI's full
  model set is expected, including the Claude and GPT-5 families. Not tested
  here, reports welcome.

## Updating or removing

- **New token** (expired or rotated): run `./install.sh` again, or replace the
  `key` in `auth.json`. Restart OpenCode.
- **New plugin version:** `git pull`, then `./install.sh --no-verify` or copy
  `copilot-pat.ts` over the old file.
- **Remove:** delete `plugin/copilot-pat.ts`, remove the `copilot-pat` entry
  from `auth.json`, and drop it from `model`/`small_model` in your config.

## Troubleshooting

Run once with logs and read the plugin's lines:

```sh
opencode run -m copilot-pat/gpt-4.1 --print-logs "Reply with exactly: PONG" </dev/null 2>&1 | grep copilot-pat
```

| symptom | cause and fix |
| --- | --- |
| `Personal Access Tokens are not supported` | classic `ghp_` token, or a fine-grained token without **Copilot Requests**, or the account has no Copilot. Create the token as in Step 1. |
| `model_not_supported` | the plan does not serve that model on this integration. Pick one that works from `opencode models`. |
| `copilot-pat/…` models missing from `opencode models` | plugin file not in the `plugin/` folder, or no `copilot-pat` entry in `auth.json`. |
| `opencode run` hangs when scripted | its stdin is an open pipe. Add `</dev/null`. |
| a model shows in `opencode models` but errors | its policy was enabled after startup, or the plan blocks it. Restart OpenCode, then try another model. |

Environment overrides, all optional:

| variable | default | use |
| --- | --- | --- |
| `COPILOT_PAT_API_URL` | `https://api.githubcopilot.com` | GitHub Enterprise or a proxy |
| `COPILOT_PAT_TOKEN_URL` | `https://api.github.com/copilot_internal/v2/token` | exchange endpoint (OAuth fallback only) |
| `COPILOT_PAT_INTEGRATION_ID` | `copilot-developer-cli` | integration header sent with the PAT |
| `COPILOT_PAT_TRACE` | unset | path of a file that gets one line per hook and request |

## How it works

- **`config` hook:** clones the `github-copilot` model catalogue from OpenCode's
  cached models.dev data (falls back to models.dev, then a small stub list) and
  registers it under `copilot-pat`, using OpenCode's bundled
  `@ai-sdk/github-copilot`.
- **`provider.models` hook:** fetches `/models` from the Copilot API and keeps
  only the catalogue entries your account can use.
- **`auth.loader`:** installs a custom `fetch` that sets
  `Authorization: Bearer <token>` and `Copilot-Integration-Id: copilot-developer-cli`
  on every request, plus the `x-initiator` and vision headers Copilot expects.
  Upstream auth rejections are rewritten into a non-retrying 401 with a
  plain-language explanation so OpenCode fails fast instead of retrying.
- If the stored key is an OAuth token (`gho_`/`ghu_`) rather than a PAT, the
  plugin exchanges it at `copilot_internal/v2/token` and caches the session
  token until two minutes before expiry.

## Security notes

- The token lives only in OpenCode's `auth.json` (mode 600 on macOS/Linux).
  This repository never contains one; the installer reads it from a hidden
  prompt or an environment variable and does not echo it.
- Give the token only the **Copilot Requests** permission. It then cannot read
  or write your repositories.
- Set an expiration and rotate by re-running the installer.

## License

MIT, see `LICENSE`.
