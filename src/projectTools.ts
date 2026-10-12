/**
 * Project onboarding + worker tools: scan a local repo, create the Venelx project for it,
 * and work with self-hosted workers (install command, metrics, usage, team assignment).
 * Writes need a token with the "write" scope.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { get, patch, post } from './client.js';
import { scanRepo } from './repoScan.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };
type ToolWrapper = <A>(handler: (args: A) => Promise<unknown>) => (args: A) => Promise<ToolResult>;

const enc = encodeURIComponent;
const BUILD_STACKS = ['expo', 'react_native', 'flutter', 'native_ios', 'native_android', 'unity'] as const;

export const WORKER_INSTALL_COMMANDS = {
  macosLinux: 'curl -fsSL https://get.venelx.com | sh',
  windowsPowerShell: 'irm https://get.venelx.com/win | iex',
} as const;

export function registerProjectTools(server: McpServer, tool: ToolWrapper): void {
  server.registerTool(
    'detect_project_setup',
    {
      description:
        'Scan a LOCAL repo folder (read-only) and suggest how to set it up on Venelx: GitHub URL + branch from git, ' +
        'build stack (expo / react_native / flutter / native_ios / native_android / unity), app root directory for monorepos, ' +
        'platforms, bundle id / package name, EAS profiles, env var NAMES from .env.example (never values), and gitignored ' +
        'build files (google-services.json etc.) that need sync_build_files. Use before create_project.',
      inputSchema: {
        directory: z.string().optional().describe('Absolute path of the repo (default: the MCP server\'s working directory)'),
      },
    },
    tool(async ({ directory }: { directory?: string }) => scanRepo(directory ?? process.cwd()))
  );

  server.registerTool(
    'create_project',
    {
      description:
        'Create a Venelx project linked to a GitHub repository and register the push webhook. Needs the "write" scope and ' +
        'GitHub connected to the account (the API rejects repos it cannot link). Follow up with update_project_settings ' +
        '(root directory, iOS scheme), set_env_var, sync_build_files / signing sync, then trigger_build. ' +
        'Tip: run detect_project_setup first and use its stack / githubUrl / branch.',
      inputSchema: {
        name: z.string().min(1).describe('Project name (the id is derived from it, lowercase with dashes)'),
        githubUrl: z.string().min(1).describe('https://github.com/org/repo'),
        buildStack: z.enum(BUILD_STACKS).optional().describe('Default: expo'),
        defaultBranch: z.string().optional(),
        description: z.string().optional(),
        registerWebhook: z.boolean().optional().describe('Register the GitHub push/PR webhook (default true)'),
      },
    },
    tool(
      async (a: {
        name: string;
        githubUrl: string;
        buildStack?: (typeof BUILD_STACKS)[number];
        defaultBranch?: string;
        description?: string;
        registerWebhook?: boolean;
      }) => {
        if (!/github\.com[/:][^/]+\/[^/]+/i.test(a.githubUrl)) {
          throw new Error('githubUrl must look like https://github.com/org/repo');
        }
        const created = (await post('/api/projects', {
          name: a.name,
          githubUrl: a.githubUrl,
          buildStack: a.buildStack,
          defaultBranch: a.defaultBranch,
          description: a.description,
          registerWebhook: a.registerWebhook ?? true,
        })) as Record<string, unknown>;
        const id = String(created.id);
        let github: unknown = null;
        try {
          const setup = (await get(`/api/projects/${enc(id)}/github-setup`)) as Record<string, unknown>;
          github = { githubAccess: setup.githubAccess ?? null, webhookActive: setup.webhookActive ?? null };
        } catch (e) {
          github = { error: e instanceof Error ? e.message : String(e) };
        }
        return {
          projectId: id,
          name: created.name,
          webhookRegistered: created.webhookRegistered ?? null,
          github,
          nextSteps: [
            'update_project_settings: rootDirectory (monorepos), iOS scheme/workspace',
            'set_env_var for each variable the build needs',
            'sync_build_files for gitignored files (google-services.json, keystore, local.properties)',
            'sync_local_ios_signing / sync_local_android_signing, then signing_status',
            'trigger_build, then build_status / tail_logs',
          ],
        };
      }
    )
  );

  server.registerTool(
    'worker_install_command',
    {
      description:
        'Get the one-line command that installs the Venelx build worker on a machine (macOS / Linux / Windows). ' +
        'After installing, the machine is paired from Dashboard → Account → Workers.',
      inputSchema: { platform: z.enum(['macos', 'linux', 'windows']).optional() },
    },
    tool(async ({ platform }: { platform?: 'macos' | 'linux' | 'windows' }) => {
      const cmd =
        platform === 'windows'
          ? WORKER_INSTALL_COMMANDS.windowsPowerShell
          : platform
            ? WORKER_INSTALL_COMMANDS.macosLinux
            : WORKER_INSTALL_COMMANDS;
      return {
        command: cmd,
        notes: [
          'The installer is unsigned: a browser download triggers a Gatekeeper/SmartScreen warning, the command-line install does not.',
          'Linux: Debian/Ubuntu x86_64 only.',
          'Then pair the machine from Dashboard → Account → Workers (or "Guided setup").',
        ],
      };
    })
  );

  server.registerTool(
    'worker_metrics',
    {
      description: 'CPU / memory / free-disk / running+queued history for one of your workers (from heartbeats, kept 7 days).',
      inputSchema: {
        workerId: z.string().min(1).describe('Worker id from list_workers'),
        range: z.enum(['1h', '24h', '7d']).optional().describe('Default 24h'),
      },
    },
    tool(async ({ workerId, range }: { workerId: string; range?: '1h' | '24h' | '7d' }) =>
      get(`/api/me/workers/${enc(workerId)}/metrics?range=${range ?? '24h'}`)
    )
  );

  server.registerTool(
    'worker_usage',
    {
      description: 'Build minutes and build counts per worker for a month (YYYY-MM, default current month).',
      inputSchema: { period: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    },
    tool(async ({ period }: { period?: string }) => get(`/api/me/workers/usage${period ? `?period=${period}` : ''}`))
  );

  server.registerTool(
    'assign_worker_team',
    {
      description:
        'Assign one of your workers to a team (the team\'s projects can then use it) or clear the assignment with teamId=null. ' +
        'You must own the worker and be owner/admin of the team. Needs the "write" scope.',
      inputSchema: {
        workerId: z.string().min(1),
        teamId: z.string().min(1).nullable().describe('Team id, or null to unassign'),
      },
    },
    tool(async ({ workerId, teamId }: { workerId: string; teamId: string | null }) =>
      patch(`/api/me/workers/${enc(workerId)}/team`, { teamId })
    )
  );
}
