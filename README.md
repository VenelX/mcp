# @venelx/mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI
assistants (Claude Code, Cursor, Kimi Code, and any MCP-compatible client) operate the
**Venelx CI/CD platform** through its REST API: list projects, trigger builds, check
build status, tail logs, list artifacts and workers, and diagnose signing / GitHub access.

The server talks to the Venelx API over HTTPS and to your AI client over **stdio**.

## Prerequisites

- **Node.js ≥ 18**
- A **Venelx account** with at least one project
- A token — either of:
  - **Browser login (recommended, no copy-pasting):**
    ```bash
    npx @venelx/mcp login
    ```
    Opens `app.venelx.com` in your browser; approve access there and the
    token is saved to `~/.venelx/mcp-token`. The server picks it up
    automatically — no `VENELX_TOKEN` env var needed.
  - **Manual token** — create one in the Venelx dashboard at
    **Account → API tokens**: <https://app.venelx.com/account/tokens>, then
    pass it as `VENELX_TOKEN` (see Configuration below).

### Token scopes

| Scope   | What it allows                                                        |
| ------- | --------------------------------------------------------------------- |
| `read`  | All read-only tools (list projects, status, logs, artifacts, …)       |
| `write` | Everything `read` allows, plus every tool that changes something: builds, web-test runs, build/test configuration, env vars, signing uploads. The API rejects any non-GET request from a read-only token. `npx @venelx/mcp login` issues a read-only token — create a read + write token at Account → API tokens for the configuration tools. |

Tokens look like `vx_...`. Treat them like passwords — pass them via environment
variables, never commit them.

## Configuration

| Environment variable | Required | Default                   | Description                     |
| -------------------- | -------- | ------------------------- | ------------------------------- |
| `VENELX_TOKEN`       | no*      | —                         | Personal API token (`vx_...`). *Not needed if you've run `npx @venelx/mcp login` — falls back to `~/.venelx/mcp-token`. |
| `VENELX_API_URL`     | no       | `https://api.venelx.com`  | API base URL (self-hosted etc.) |

## Install & run

### Straight from GitHub (latest source, no npm release needed)

`npx` can run the server directly from the [VenelX/mcp](https://github.com/VenelX/mcp) repo —
npm clones it and builds it (`prepare`) on first run:

```bash
claude mcp add venelx -e VENELX_TOKEN=vx_... -- npx -y github:VenelX/mcp
```

Pin a release with a tag (`github:VenelX/mcp#v0.1.2`); without one you get `main`.

### Claude Code

```bash
claude mcp add venelx --env VENELX_TOKEN=vx_... -- npx -y @venelx/mcp
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "venelx": {
      "command": "npx",
      "args": ["-y", "@venelx/mcp"],
      "env": {
        "VENELX_TOKEN": "vx_..."
      }
    }
  }
}
```

### Kimi Code / generic MCP client

Same shape as above — add to your client's MCP JSON config:

```json
{
  "mcpServers": {
    "venelx": {
      "command": "npx",
      "args": ["-y", "@venelx/mcp"],
      "env": {
        "VENELX_TOKEN": "vx_...",
        "VENELX_API_URL": "https://api.venelx.com"
      }
    }
  }
}
```

### Local development

```bash
git clone <repo> && cd venelx-mcp
npm install
npm run build
```

Then point your MCP client config at the local build:

```json
{
  "mcpServers": {
    "venelx": {
      "command": "node",
      "args": ["/path/to/venelx-mcp/dist/index.js"],
      "env": {
        "VENELX_TOKEN": "vx_..."
      }
    }
  }
}
```

## Tools

| Tool            | Scope needed | What it does                                                                 |
| --------------- | ------------ | ---------------------------------------------------------------------------- |
| `list_projects` | read         | List projects the token can access (id, name, GitHub URL, platforms, role).  |
| `get_project`   | read         | Project details plus a GitHub access summary.                                |
| `trigger_build` | **write**    | Queue a build for a platform (`ios`, `android`, …). Surfaces `skipReason` (e.g. `signing_not_ready`, `github_token_invalid`). |
| `build_status`  | read         | Current pipeline status per platform + the 10 most recent builds.            |
| `tail_logs`     | read         | Last N lines of a build log (latest build, or a given `buildId`).            |
| `list_artifacts`| read         | Build artifacts for a project.                                               |
| `list_workers`  | read         | Build workers owned by the account (name, status, capabilities).             |
| `signing_status`| read         | Code-signing readiness, optionally per platform (`ios`/`android`).           |
| `github_access` | read         | GitHub repo access diagnosis: `githubAccess {ok, reason, message}` + auth source label. |
| `discover_local_ios_signing` | read | **macOS only.** List provisioning profiles (`~/Library/MobileDevice/Provisioning Profiles`) and Keychain code-signing identities on this machine. Read-only, nothing uploaded. |
| `sync_local_ios_signing` | **write** | **macOS only.** Export the matching Distribution cert + key from Keychain and upload it with the best-matching local provisioning profile(s) as this project's iOS signing credentials. Only one extension bundle ID (e.g. a share extension) can be synced today — see Limitations below. |
| `discover_local_android_signing` | read | Scan a local project checkout's `android/` dir for a keystore + gradle.properties credentials. Read-only. |
| `sync_local_android_signing` | **write** | Upload a local project checkout's release keystore as this project's Android signing credentials. |
| `get_build_config` | read | Build stack, build targets (with triggers), build commands per target, and project settings (`rootDirectory`, `defaultBranch`, `iosScheme`). |
| `update_project_settings` | **write** | Set `rootDirectory` (monorepo sub-folder), `defaultBranch`, `iosScheme` or the project name. Only passed fields change. |
| `update_build_commands` | **write** | Replace the build steps of ONE target (others untouched). Commands are validated server-side; rejected ones are listed in the error. |
| `reset_build_commands` | **write** | Reset all build commands to the stack defaults. |
| `set_build_stack` | **write** | Change the build stack (`applyPresets: true` also replaces targets + commands with the stack defaults). |
| `update_build_target` / `remove_build_target` | **write** | Add, edit or delete one build target (platform, profile, artifact type, PR/push triggers). Custom build commands are preserved. |
| `list_env_vars` / `set_env_var` / `delete_env_var` | read / **write** | Build environment variables (encrypted; values never returned). |
| `test_runs` / `update_test_config` | read / **write** | App-test (Maestro) runs and configuration — partial updates merge into the stored config. |
| `list_web_sites` / `create_web_site` / `update_web_site` / `delete_web_site` | read / **write** | Playwright web-test sites. `delete_web_site` is permanent. |
| `get_web_site_config` / `update_web_site_config` | read / **write** | Targets, no-code flows, schedule, triggers, notifications. Credentials are masked on read and kept when sent back masked. |
| `run_web_test` / `web_test_runs` / `approve_web_baseline` | **write** / read / **write** | Queue a web test, read results, accept screenshots as the visual baseline. |
| `set_web_site_secrets` / `validate_web_flow` | **write** | Secrets for repo-mode site builds; check a flow without saving. |

### Local signing sync — limitations

- **iOS only supports one extra provisioning profile per project today** (whichever sub-bundle-ID
  extension is found locally — typically a share extension). If your app has multiple extension
  targets (share extension **and** widget, for example), only one gets synced; `sync_local_ios_signing`'s
  response lists every extension bundle ID it found so you can see what was skipped. Supporting
  arbitrary extension counts needs a larger change to how Venelx stores iOS signing credentials —
  not done yet.
- `sync_local_ios_signing` exports **every** codesigning identity in your login Keychain into one
  `.p12` (macOS's `security export` doesn't cleanly filter to a single identity) and refuses to run
  at all if no `Distribution` identity is present, since an AppStore/AdHoc profile without a matching
  Distribution cert+key can't actually sign a release build.

## Troubleshooting

- **401 Authentication failed** — `VENELX_TOKEN` is missing, wrong, or revoked.
  Create a new token at Account → API tokens (<https://app.venelx.com/account/tokens>)
  and update your MCP config.
- **403 Forbidden on `trigger_build`** — your token only has the `read` scope.
  Create a token with the **write** scope.
- **Could not reach the Venelx API (ECONNREFUSED / ENOTFOUND)** — the API base URL is
  unreachable. Check `VENELX_API_URL` (defaults to `https://api.venelx.com`) and your network.
- **Nothing happens / no output** — MCP servers speak JSON-RPC on stdout; run it through
  your MCP client, not directly in a terminal. Diagnostics are printed to stderr.

## License

MIT
