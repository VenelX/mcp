# @venelx/mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI
assistants (Claude Code, Cursor, Kimi Code, and any MCP-compatible client) operate the
**Venelx CI/CD platform** through its REST API: list projects, trigger builds, check
build status, tail logs, list artifacts and workers, and diagnose signing / GitHub access.

The server talks to the Venelx API over HTTPS and to your AI client over **stdio**.

## Prerequisites

- **Node.js ≥ 18**
- A **Venelx account** with at least one project
- A **personal API token** — create one in the Venelx dashboard at
  **Account → API tokens**: <https://app.venelx.com/account/tokens>

### Token scopes

| Scope   | What it allows                                                        |
| ------- | --------------------------------------------------------------------- |
| `read`  | All read-only tools (list projects, status, logs, artifacts, …)       |
| `write` | Everything `read` allows, plus `trigger_build` (build-trigger endpoints) |

Tokens look like `vx_...`. Treat them like passwords — pass them via environment
variables, never commit them.

## Configuration

| Environment variable | Required | Default                   | Description                     |
| -------------------- | -------- | ------------------------- | ------------------------------- |
| `VENELX_TOKEN`       | yes      | —                         | Personal API token (`vx_...`)   |
| `VENELX_API_URL`     | no       | `https://api.venelx.com`  | API base URL (self-hosted etc.) |

## Install & run

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
