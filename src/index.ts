#!/usr/bin/env node
/**
 * Venelx MCP server — lets AI assistants operate the Venelx CI/CD platform
 * (projects, builds, logs, artifacts, workers, signing, GitHub access) over stdio.
 *
 * IMPORTANT: never write to stdout — the stdio transport owns it. Log to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, apiUrl, get, post } from './client.js';

const TOKEN_SETUP_HINT =
  'Create a token at Account → API tokens (https://app.venelx.com/account/tokens).';

const server = new McpServer({
  name: 'venelx',
  version: '0.1.0',
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

function fail(err: unknown) {
  let text: string;
  if (err instanceof ApiError) {
    if (err.status === 401) {
      text =
        `Authentication failed (401): ${err.message}. ` +
        `VENELX_TOKEN is missing, invalid, or revoked. ${TOKEN_SETUP_HINT}`;
    } else if (err.status === 403) {
      text =
        `Forbidden (403): ${err.message}. ` +
        `The token is invalid/revoked, or it lacks the required scope ` +
        `(build triggers need the "write" scope). ${TOKEN_SETUP_HINT}`;
    } else {
      text = `Venelx API error (${err.status}): ${err.message}`;
    }
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/** Wrap a tool handler so API errors come back as isError results instead of throwing. */
function tool<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  };
}

interface HistoryRow {
  id: string;
  platform?: string;
  status?: string;
  startTime?: string;
  [key: string]: unknown;
}

/** /api/:projectId/history returns rows grouped by platform; flatten + sort newest first. */
function flattenHistory(history: unknown): HistoryRow[] {
  if (!history || typeof history !== 'object') return [];
  const rows = Object.values(history as Record<string, HistoryRow[]>)
    .filter(Array.isArray)
    .flat();
  return rows.sort((a, b) => String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')));
}

const projectIdSchema = z.string().min(1).describe('Venelx project ID');

// ─── Tools ──────────────────────────────────────────────────────────────────

server.registerTool(
  'list_projects',
  {
    description: 'List all Venelx projects the API token can access (id, name, GitHub URL, platforms, role).',
    inputSchema: {},
  },
  tool(async () => {
    const projects = (await get('/api/projects')) as Record<string, unknown>[];
    const list = Array.isArray(projects) ? projects : [];
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      githubUrl: p.githubUrl,
      platforms: p.platforms ?? (p.metadata as { platforms?: unknown } | undefined)?.platforms ?? null,
      accessRole: p.accessRole ?? null,
      isOwner: p.isOwner ?? null,
    }));
  })
);

server.registerTool(
  'get_project',
  {
    description:
      'Get full details for one Venelx project, including a summary of its GitHub access state.',
    inputSchema: { projectId: projectIdSchema },
  },
  tool(async ({ projectId }: { projectId: string }) => {
    const [project, setup] = await Promise.all([
      get(`/api/projects/${encodeURIComponent(projectId)}`),
      get(`/api/projects/${encodeURIComponent(projectId)}/github-setup`),
    ]);
    const gh = setup as Record<string, unknown>;
    return {
      project,
      github: {
        githubAccess: gh.githubAccess ?? null,
        githubAuth: gh.githubAuth ?? null,
        webhookActive: gh.webhookActive ?? null,
        repoFullName: gh.repoFullName ?? null,
        defaultBranch: gh.defaultBranch ?? null,
      },
    };
  })
);

server.registerTool(
  'trigger_build',
  {
    description:
      'Trigger a CI/CD build for a project on a platform (e.g. "ios" or "android"). ' +
      'Requires an API token with the write scope. Returns jobId/status/message; ' +
      'a skipped build includes a skipReason (e.g. signing_not_ready, github_token_invalid).',
    inputSchema: {
      projectId: projectIdSchema,
      platform: z.string().min(1).describe('Build platform / flow id, e.g. "ios" or "android"'),
    },
  },
  tool(async ({ projectId, platform }: { projectId: string; platform: string }) => {
    return post(
      `/api/${encodeURIComponent(projectId)}/build/${encodeURIComponent(platform)}`,
      {}
    );
  })
);

server.registerTool(
  'build_status',
  {
    description:
      'Get the current build pipeline status per platform plus the 10 most recent builds for a project.',
    inputSchema: { projectId: projectIdSchema },
  },
  tool(async ({ projectId }: { projectId: string }) => {
    const id = encodeURIComponent(projectId);
    const [status, history] = await Promise.all([
      get(`/api/${id}/status`),
      get(`/api/${id}/history`),
    ]);
    const recentBuilds = flattenHistory(history)
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        platform: row.platform ?? null,
        status: row.status ?? null,
        startTime: row.startTime ?? null,
        buildNumber: row.buildNumber ?? null,
        appVersion: row.appVersion ?? null,
        gitCommit: row.gitCommit ?? null,
        duration: row.duration ?? null,
        artifactFile: row.artifactFile ?? null,
      }));
    return { status, recentBuilds };
  })
);

server.registerTool(
  'tail_logs',
  {
    description:
      'Return the last N lines of a build log. If buildId is omitted, the most recent build of the project is used.',
    inputSchema: {
      projectId: projectIdSchema,
      buildId: z.string().optional().describe('Build history ID; defaults to the latest build'),
      lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Number of log lines to return (default 100)'),
    },
  },
  tool(
    async ({
      projectId,
      buildId,
      lines = 100,
    }: {
      projectId: string;
      buildId?: string;
      lines?: number;
    }) => {
      let id = buildId;
      if (!id) {
        const history = await get(`/api/${encodeURIComponent(projectId)}/history`);
        const latest = flattenHistory(history)[0];
        if (!latest?.id) {
          return { message: 'No builds found for this project yet.', logs: '' };
        }
        id = latest.id;
      }
      const build = (await get(`/api/history/logs/${encodeURIComponent(id)}`)) as {
        id?: string;
        platform?: string;
        status?: string;
        startTime?: string;
        logs?: string | null;
      };
      const allLines = String(build.logs ?? '').split('\n');
      const tail = allLines.slice(-lines);
      return {
        buildId: build.id ?? id,
        platform: build.platform ?? null,
        status: build.status ?? null,
        startTime: build.startTime ?? null,
        totalLines: allLines.length,
        returnedLines: tail.length,
        logs: tail.join('\n'),
      };
    }
  )
);

server.registerTool(
  'list_artifacts',
  {
    description: 'List build artifacts (installable binaries etc.) for a project.',
    inputSchema: { projectId: projectIdSchema },
  },
  tool(async ({ projectId }: { projectId: string }) => {
    return get(`/api/${encodeURIComponent(projectId)}/artifacts`);
  })
);

server.registerTool(
  'list_workers',
  {
    description:
      'List the build workers owned by the current account (name, status, capabilities).',
    inputSchema: {},
  },
  tool(async () => {
    const workers = (await get('/api/me/workers')) as Record<string, unknown>[];
    const list = Array.isArray(workers) ? workers : [];
    return list.map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status ?? null,
      platforms: w.platforms ?? w.capabilities ?? null,
      version: w.version ?? null,
      lastHeartbeatAt: w.lastHeartbeatAt ?? w.lastSeenAt ?? null,
    }));
  })
);

server.registerTool(
  'signing_status',
  {
    description:
      'Check code-signing readiness for a project. Optionally filter by platform ("ios" or "android").',
    inputSchema: {
      projectId: projectIdSchema,
      platform: z
        .enum(['ios', 'android'])
        .optional()
        .describe('Platform to check; omit to check all platforms'),
    },
  },
  tool(async ({ projectId, platform }: { projectId: string; platform?: string }) => {
    const query = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    return get(`/api/${encodeURIComponent(projectId)}/signing/status${query}`);
  })
);

server.registerTool(
  'github_access',
  {
    description:
      'Diagnose GitHub repository access for a project: githubAccess {ok, reason, message} and the githubAuth credential source label.',
    inputSchema: { projectId: projectIdSchema },
  },
  tool(async ({ projectId }: { projectId: string }) => {
    const setup = (await get(
      `/api/projects/${encodeURIComponent(projectId)}/github-setup`
    )) as Record<string, unknown>;
    return {
      githubUrl: setup.githubUrl ?? null,
      githubAccess: setup.githubAccess ?? null,
      githubAuth: setup.githubAuth ?? null,
      ownerGithubConnected: setup.ownerGithubConnected ?? null,
      webhookActive: setup.webhookActive ?? null,
      repoFullName: setup.repoFullName ?? null,
      defaultBranch: setup.defaultBranch ?? null,
    };
  })
);

// ─── Startup / shutdown ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[venelx-mcp] server running on stdio (API: ${apiUrl()})`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[venelx-mcp] received ${signal}, shutting down`);
  try {
    await server.close();
  } catch {
    // ignore — we are exiting anyway
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
