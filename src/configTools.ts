/**
 * Configuration tools — edit what the dashboard edits: build commands, build
 * targets, build stack, project settings (root directory, branch, iOS scheme),
 * env vars, app-test config and web-test sites. All writes need a token with the
 * "write" scope. Server endpoints replace whole documents (pipelineConfig, flows,
 * test config, site config), so every update here reads the current value and
 * merges first — a partial update never wipes the rest.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { del, get, patch, post, put } from './client.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };
type ToolWrapper = <A>(handler: (args: A) => Promise<unknown>) => (args: A) => Promise<ToolResult>;

type PipelineStep = { id: string; name: string; command: string; enabled: boolean };
type PipelineConfig = Record<string, PipelineStep[]>;
type PlatformFlow = Record<string, unknown> & { id: string };

const enc = encodeURIComponent;
const projectIdSchema = z.string().min(1).describe('Venelx project ID');

const BUILD_STACKS = ['expo', 'react_native', 'flutter', 'native_ios', 'native_android', 'unity', 'unity_web'] as const;

const stepSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Step id. Use "build" to replace the stack\'s build step; other ids run before it.'),
  name: z.string().min(1).describe('Label shown in logs'),
  command: z
    .string()
    .min(1)
    .describe(
      'Shell command(s), chained with && / ; / ||. Template vars: {{outPath}} (artifact destination — ' +
        'the build must cp its .apk/.aab/.ipa here), {{platform}}, {{profile}}, {{branch}}, {{artifactExt}}, ' +
        '{{iosWorkspace}}, {{iosScheme}}. Runs from the project root directory. No $(), backticks, pipes, ' +
        'sudo, curl/wget, or absolute/.. paths.'
    ),
  enabled: z.boolean().optional().describe('Default true'),
});

/** Repo-relative folder: no leading slash, no `..`. Empty clears it. */
function normalizeRootDirectory(raw: string): string {
  const clean = raw.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (clean.split('/').includes('..')) throw new Error('rootDirectory must stay inside the repo (no "..").');
  return clean;
}

function assertBranchName(branch: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error(`"${branch}" is not a valid git branch name.`);
  }
}

const REDACTED = '••••••••';

/** Mask web-test target credentials (the API returns them in plaintext). */
function redactTargetAuth(config: unknown): unknown {
  const cfg = structuredClone(config) as { targets?: { auth?: Record<string, unknown> }[] } | null;
  for (const t of cfg?.targets ?? []) {
    const auth = t.auth;
    if (!auth) continue;
    if (typeof auth.password === 'string') auth.password = REDACTED;
    if (auth.headers && typeof auth.headers === 'object') {
      for (const k of Object.keys(auth.headers)) (auth.headers as Record<string, string>)[k] = REDACTED;
    }
    if (Array.isArray(auth.cookies)) {
      for (const c of auth.cookies as { value?: string }[]) c.value = REDACTED;
    }
  }
  return cfg;
}

/** A target sent back with masked auth keeps the stored credentials. */
function restoreRedactedAuth(
  next: { id?: string; auth?: unknown }[],
  prev: { id?: string; auth?: unknown }[]
): void {
  for (const t of next) {
    if (t.auth && JSON.stringify(t.auth).includes(REDACTED)) {
      const stored = prev.find((p) => p.id === t.id)?.auth;
      if (!stored) throw new Error(`Target "${t.id}" has masked credentials but no stored auth to keep — send the real values.`);
      t.auth = stored;
    }
  }
}

export function registerConfigTools(server: McpServer, tool: ToolWrapper): void {
  // ─── Build configuration ────────────────────────────────────────────────

  server.registerTool(
    'get_build_config',
    {
      description:
        'Everything that decides how a project builds: build stack, build targets (platform flows with ' +
        'triggers), the build commands per target, and project settings (rootDirectory, defaultBranch, ' +
        'iosScheme). Read this before changing any of them.',
      inputSchema: { projectId: projectIdSchema },
    },
    tool(async ({ projectId }: { projectId: string }) => {
      const id = enc(projectId);
      const [project, stack, flows, pipeline] = await Promise.all([
        get(`/api/projects/${id}`) as Promise<{ name?: string; metadata?: Record<string, unknown> }>,
        get(`/api/${id}/build-stack`) as Promise<Record<string, unknown>>,
        get(`/api/${id}/platform-flows`) as Promise<{ flows?: unknown }>,
        get(`/api/${id}/build-stack/pipeline`) as Promise<{ pipelineConfig?: unknown }>,
      ]);
      const meta = project.metadata ?? {};
      return {
        name: project.name,
        settings: {
          rootDirectory: meta.rootDirectory ?? '',
          defaultBranch: meta.defaultBranch ?? null,
          iosScheme: meta.iosScheme ?? null,
        },
        buildStack: stack.stack,
        buildStackDetection: stack.detection ?? null,
        availableStacks: stack.stacks ?? BUILD_STACKS,
        targets: flows.flows ?? [],
        buildCommands: pipeline.pipelineConfig ?? {},
        notes:
          'buildCommands is keyed by target id ("default" applies to targets without their own entry). ' +
          'Commands run from settings.rootDirectory inside the repo.',
      };
    })
  );

  server.registerTool(
    'update_project_settings',
    {
      description:
        'Change project settings: rootDirectory (repo sub-folder the build runs in — e.g. "apps/mobile" ' +
        'for a monorepo; "" for the repo root), defaultBranch, iosScheme, or the project name. ' +
        'Only the fields you pass change.',
      inputSchema: {
        projectId: projectIdSchema,
        rootDirectory: z.string().optional(),
        defaultBranch: z.string().optional(),
        iosScheme: z.string().optional().describe('Xcode scheme ("" = auto-detect)'),
        name: z.string().min(1).max(120).optional(),
      },
    },
    tool(
      async (args: {
        projectId: string;
        rootDirectory?: string;
        defaultBranch?: string;
        iosScheme?: string;
        name?: string;
      }) => {
        const metadata: Record<string, unknown> = {};
        if (args.rootDirectory !== undefined) metadata.rootDirectory = normalizeRootDirectory(args.rootDirectory);
        if (args.defaultBranch !== undefined) {
          assertBranchName(args.defaultBranch);
          metadata.defaultBranch = args.defaultBranch;
        }
        if (args.iosScheme !== undefined) metadata.iosScheme = args.iosScheme.trim();
        const body: Record<string, unknown> = {};
        if (Object.keys(metadata).length) body.metadata = metadata; // server shallow-merges metadata
        if (args.name !== undefined) body.name = args.name;
        if (!Object.keys(body).length) throw new Error('Nothing to update — pass at least one field.');
        const updated = (await patch(`/api/projects/${enc(args.projectId)}`, body)) as {
          name?: string;
          metadata?: Record<string, unknown>;
        };
        const meta = updated.metadata ?? {};
        return {
          message: 'Project settings updated',
          name: updated.name,
          rootDirectory: meta.rootDirectory ?? '',
          defaultBranch: meta.defaultBranch ?? null,
          iosScheme: meta.iosScheme ?? null,
        };
      }
    )
  );

  server.registerTool(
    'update_build_commands',
    {
      description:
        'Set the build commands (pipeline steps) for ONE build target, e.g. targetId "android-production". ' +
        'Other targets keep their commands. The steps you pass replace that target\'s steps; system steps ' +
        '(clone, install, signing) are added automatically. Use targetId "default" for targets without ' +
        'their own entry. Commands are validated server-side — rejected ones are listed in the error.',
      inputSchema: {
        projectId: projectIdSchema,
        targetId: z.string().min(1).describe('Build target id from get_build_config (or "default")'),
        steps: z.array(stepSchema).min(1),
      },
    },
    tool(async ({ projectId, targetId, steps }: { projectId: string; targetId: string; steps: z.infer<typeof stepSchema>[] }) => {
      const id = enc(projectId);
      const current = (await get(`/api/${id}/build-stack/pipeline`)) as {
        pipelineConfig?: PipelineConfig;
        flows?: { id: string }[];
      };
      const known = new Set(['default', ...(current.flows ?? []).map((f) => f.id)]);
      if (!known.has(targetId)) {
        throw new Error(`Unknown build target "${targetId}". Known: ${[...known].join(', ')}.`);
      }
      const pipelineConfig: PipelineConfig = {
        ...(current.pipelineConfig ?? {}),
        [targetId]: steps.map((s) => ({ ...s, enabled: s.enabled !== false })),
      };
      const saved = (await put(`/api/${id}/build-stack/pipeline`, { pipelineConfig })) as {
        pipelineConfig?: PipelineConfig;
      };
      return { message: `Build commands saved for ${targetId}`, buildCommands: saved.pipelineConfig?.[targetId] ?? steps };
    })
  );

  server.registerTool(
    'reset_build_commands',
    {
      description: 'Reset every target\'s build commands to the build stack\'s defaults (discards custom commands).',
      inputSchema: { projectId: projectIdSchema },
    },
    tool(async ({ projectId }: { projectId: string }) => post(`/api/${enc(projectId)}/build-stack/pipeline/reset-defaults`))
  );

  server.registerTool(
    'set_build_stack',
    {
      description:
        'Set the project\'s build stack. By default only the stack changes (targets and commands are kept). ' +
        'applyPresets=true REPLACES the build targets and build commands with the stack\'s defaults.',
      inputSchema: {
        projectId: projectIdSchema,
        stack: z.enum(BUILD_STACKS),
        applyPresets: z.boolean().optional().describe('Default false'),
      },
    },
    tool(async ({ projectId, stack, applyPresets }: { projectId: string; stack: string; applyPresets?: boolean }) =>
      put(`/api/${enc(projectId)}/build-stack`, { stack, applyPresets: applyPresets === true })
    )
  );

  server.registerTool(
    'update_build_target',
    {
      description:
        'Add or edit ONE build target (platform flow): label, platform, EAS profile, artifact type, ' +
        'enabled, and triggers (build on PR / on push to a branch). Fields you omit keep their value; ' +
        'other targets are untouched and existing build commands are preserved.',
      inputSchema: {
        projectId: projectIdSchema,
        targetId: z.string().min(1).describe('Existing target id to edit, or a new id (lowercase, a-z0-9_-)'),
        label: z.string().max(80).optional(),
        platform: z.enum(['ios', 'android']).optional().describe('Required for a new target'),
        easProfile: z.string().max(64).optional().describe('eas.json build profile (Expo stack)'),
        artifactExtension: z.enum(['.ipa', '.apk', '.aab', '.zip']).optional().describe('Required for a new target'),
        enabled: z.boolean().optional(),
        downloadable: z.boolean().optional(),
        onPullRequest: z.boolean().optional().describe('Build on pull requests'),
        onPushDefaultBranch: z.boolean().optional().describe('Build on push to the trigger branch'),
        triggerBranch: z.string().optional().describe('Branch for push builds ("" = project default branch)'),
      },
    },
    tool(
      async (args: {
        projectId: string;
        targetId: string;
        label?: string;
        platform?: 'ios' | 'android';
        easProfile?: string;
        artifactExtension?: string;
        enabled?: boolean;
        downloadable?: boolean;
        onPullRequest?: boolean;
        onPushDefaultBranch?: boolean;
        triggerBranch?: string;
      }) => {
        const id = enc(args.projectId);
        const [flowsRes, pipelineRes] = await Promise.all([
          get(`/api/${id}/platform-flows`) as Promise<{ flows?: PlatformFlow[] }>,
          get(`/api/${id}/build-stack/pipeline`) as Promise<{ pipelineConfig?: PipelineConfig }>,
        ]);
        const flows = [...(flowsRes.flows ?? [])];
        const idx = flows.findIndex((f) => f.id === args.targetId);
        if (idx < 0 && (!args.platform || !args.artifactExtension)) {
          throw new Error('New target needs platform and artifactExtension.');
        }
        if (args.triggerBranch) assertBranchName(args.triggerBranch);
        const prev: PlatformFlow = idx >= 0 ? flows[idx] : { id: args.targetId, order: flows.length };
        const prevTriggers = (prev.triggers as Record<string, unknown> | undefined) ?? {};
        const next: PlatformFlow = {
          ...prev,
          ...(args.label !== undefined && { label: args.label }),
          ...(args.platform !== undefined && { easPlatform: args.platform }),
          ...(args.easProfile !== undefined && { easProfile: args.easProfile }),
          ...(args.artifactExtension !== undefined && { artifactExtension: args.artifactExtension }),
          ...(args.enabled !== undefined && { enabled: args.enabled }),
          ...(args.downloadable !== undefined && { downloadable: args.downloadable }),
          triggers: {
            ...prevTriggers,
            ...(args.onPullRequest !== undefined && { onPullRequest: args.onPullRequest }),
            ...(args.onPushDefaultBranch !== undefined && { onPushDefaultBranch: args.onPushDefaultBranch }),
            ...(args.triggerBranch !== undefined && { branch: args.triggerBranch }),
          },
        };
        if (idx >= 0) flows[idx] = next;
        else flows.push(next);

        // Saving flows regenerates build commands from stack defaults server-side —
        // put the existing custom commands back afterwards.
        const saved = (await put(`/api/${id}/platform-flows`, { flows })) as { flows?: PlatformFlow[] };
        const before = pipelineRes.pipelineConfig ?? {};
        const keep = new Set(['default', ...(saved.flows ?? flows).map((f) => f.id)]);
        const restored = Object.fromEntries(Object.entries(before).filter(([k]) => keep.has(k)));
        if (Object.keys(restored).length) {
          const after = (await get(`/api/${id}/build-stack/pipeline`)) as { pipelineConfig?: PipelineConfig };
          await put(`/api/${id}/build-stack/pipeline`, {
            pipelineConfig: { ...(after.pipelineConfig ?? {}), ...restored },
          });
        }
        return {
          message: idx >= 0 ? `Build target ${args.targetId} updated` : `Build target ${args.targetId} added`,
          target: (saved.flows ?? flows).find((f) => f.id === args.targetId) ?? next,
          buildCommandsPreserved: Object.keys(restored),
        };
      }
    )
  );

  server.registerTool(
    'remove_build_target',
    {
      description: 'Delete one build target (and its build commands). At least one enabled target must remain.',
      inputSchema: { projectId: projectIdSchema, targetId: z.string().min(1) },
    },
    tool(async ({ projectId, targetId }: { projectId: string; targetId: string }) => {
      const id = enc(projectId);
      const [flowsRes, pipelineRes] = await Promise.all([
        get(`/api/${id}/platform-flows`) as Promise<{ flows?: PlatformFlow[] }>,
        get(`/api/${id}/build-stack/pipeline`) as Promise<{ pipelineConfig?: PipelineConfig }>,
      ]);
      const flows = (flowsRes.flows ?? []).filter((f) => f.id !== targetId);
      if (flows.length === (flowsRes.flows ?? []).length) throw new Error(`No build target "${targetId}".`);
      await put(`/api/${id}/platform-flows`, { flows });
      const restored = Object.fromEntries(
        Object.entries(pipelineRes.pipelineConfig ?? {}).filter(([k]) => k !== targetId)
      );
      if (Object.keys(restored).length) {
        const after = (await get(`/api/${id}/build-stack/pipeline`)) as { pipelineConfig?: PipelineConfig };
        const merged = { ...(after.pipelineConfig ?? {}), ...restored };
        delete merged[targetId];
        await put(`/api/${id}/build-stack/pipeline`, { pipelineConfig: merged });
      }
      return { message: `Build target ${targetId} removed`, remainingTargets: flows.map((f) => f.id) };
    })
  );

  // ─── Environment variables ──────────────────────────────────────────────

  server.registerTool(
    'list_env_vars',
    {
      description: 'List a project\'s build environment variable names (values are always masked).',
      inputSchema: { projectId: projectIdSchema },
    },
    tool(async ({ projectId }: { projectId: string }) => {
      const rows = (await get(`/api/${enc(projectId)}/settings/env-vars`)) as { id: string; key: string; createdAt?: string }[];
      return (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, key: r.key, createdAt: r.createdAt ?? null }));
    })
  );

  server.registerTool(
    'set_env_var',
    {
      description: 'Create or update a build environment variable (stored encrypted, injected into every build).',
      inputSchema: {
        projectId: projectIdSchema,
        key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,120}$/, 'Use letters, digits and _'),
        value: z.string().min(1),
      },
    },
    tool(async ({ projectId, key, value }: { projectId: string; key: string; value: string }) => {
      await post(`/api/${enc(projectId)}/settings/env-vars`, { key, value, isSecret: true });
      return { message: `${key} saved` };
    })
  );

  server.registerTool(
    'delete_env_var',
    {
      description: 'Delete a build environment variable by name.',
      inputSchema: { projectId: projectIdSchema, key: z.string().min(1) },
    },
    tool(async ({ projectId, key }: { projectId: string; key: string }) => {
      const id = enc(projectId);
      const rows = (await get(`/api/${id}/settings/env-vars`)) as { id: string; key: string }[];
      const matches = (Array.isArray(rows) ? rows : []).filter((r) => r.key === key);
      if (!matches.length) throw new Error(`No env var named ${key}.`);
      for (const r of matches) await del(`/api/${id}/settings/env-vars/${enc(r.id)}`);
      return { message: `${key} deleted`, rowsRemoved: matches.length };
    })
  );

  // ─── App testing (Maestro) ──────────────────────────────────────────────

  server.registerTool(
    'update_test_config',
    {
      description:
        'Change a project\'s app-test (Maestro) configuration. Only the fields you pass change. ' +
        'Read the current config with test_runs.',
      inputSchema: {
        projectId: projectIdSchema,
        enabled: z.boolean().optional(),
        testPath: z.string().optional().describe('Repo-relative folder of Maestro flows (default .maestro)'),
        targetFlowId: z.string().optional().describe('Build target whose artifact is tested (e.g. android-preview)'),
        device: z.string().optional(),
        extraArgs: z.string().optional().describe('Extra maestro CLI args (no shell metacharacters)'),
        timeoutMinutes: z.number().int().min(3).max(180).optional(),
        failBuildOnTestFailure: z.boolean().optional(),
        afterBuild: z.boolean().optional().describe('Run after each successful build of the target'),
        onPullRequest: z.boolean().optional(),
        onPush: z.boolean().optional(),
      },
    },
    tool(async (args: Record<string, unknown> & { projectId: string }) => {
      const id = enc(args.projectId);
      const current = ((await get(`/api/${id}/testing/config`)) as { config?: Record<string, unknown> }).config ?? {};
      const { projectId: _p, afterBuild, onPullRequest, onPush, ...fields } = args;
      const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const triggers = {
        ...((current.triggers as Record<string, unknown>) ?? {}),
        ...(afterBuild !== undefined && { afterBuild }),
        ...(onPullRequest !== undefined && { onPullRequest }),
        ...(onPush !== undefined && { onPush }),
      };
      return put(`/api/${id}/testing/config`, { config: { ...current, ...defined, triggers } });
    })
  );

  // ─── Web testing (Playwright) ───────────────────────────────────────────

  server.registerTool(
    'create_web_site',
    {
      description:
        'Add a website for Playwright web testing. Give a live url (url mode) and/or a GitHub repoUrl ' +
        '(repo mode: Venelx builds and serves the site itself). Creates one default target.',
      inputSchema: {
        name: z.string().min(1).max(80),
        url: z.string().url().optional(),
        repoUrl: z.string().optional().describe('GitHub URL or owner/repo'),
        branch: z.string().optional(),
      },
    },
    tool(async (args: { name: string; url?: string; repoUrl?: string; branch?: string }) => {
      if (!args.url && !args.repoUrl) throw new Error('Pass url and/or repoUrl.');
      return post('/api/web-testing/sites', args);
    })
  );

  server.registerTool(
    'get_web_site_config',
    {
      description:
        'Full web-test configuration for a site: targets (url/repo mode, viewports, checks, crawl, ' +
        'thresholds, auth), flows (no-code browser steps), schedule, triggers and notifications. ' +
        'Target credentials are masked; send them back masked to keep them.',
      inputSchema: { siteId: z.string().min(1) },
    },
    tool(async ({ siteId }: { siteId: string }) => {
      const res = (await get(`/api/web-testing/sites/${enc(siteId)}/config`)) as { config?: unknown; deployHookUrl?: string };
      return { config: redactTargetAuth(res.config), deployHookUrl: res.deployHookUrl ?? null };
    })
  );

  server.registerTool(
    'update_web_site_config',
    {
      description:
        'Change a site\'s web-test configuration. Top-level fields you pass replace the stored ones ' +
        '(e.g. pass `schedule` to change only the schedule; `targets` / `flows` replace the whole list — ' +
        'get_web_site_config first and edit that). Validate flows with validate_web_flow. ' +
        'Shape: { enabled, targets:[{id,name,mode:"url"|"repo",url,branchUrlTemplate,repo:{branch,framework,' +
        'installCommand,buildCommand,startCommand,port,readyPath,rootDirectory,envKeys},auth,viewports:["desktop"|"mobile"],' +
        'checks:{siteCheck,flows,codeTests,accessibility,visualDiff},crawl:{maxPages,maxDepth,includePaths,excludePaths},' +
        'thresholds:{visualDiffPercent,maxConsoleErrors,failOnRequestErrors},codeTestsPath,timeoutMinutes}], ' +
        'flows:[{id,name,description,startUrl,steps:[{do:"goto"|"click"|"fill"|"select"|"press"|"hover"|"waitFor"|' +
        '"expectText"|"expectVisible"|"expectUrl"|"expectNoConsoleErrors"|"screenshot"|"login",...}],enabled}], ' +
        'schedule:{enabled,every:"hourly"|"6h"|"daily"|"weekly",at:"HH:MM",weekday,timezone,targetIds}, ' +
        'triggers:{onDeployHook}, notifications:{onFailure,onRecovery} }.',
      inputSchema: {
        siteId: z.string().min(1),
        enabled: z.boolean().optional(),
        targets: z.array(z.record(z.unknown())).optional(),
        flows: z.array(z.record(z.unknown())).optional(),
        schedule: z.record(z.unknown()).optional(),
        triggers: z.record(z.unknown()).optional(),
        notifications: z.record(z.unknown()).optional(),
      },
    },
    tool(async ({ siteId, ...changes }: { siteId: string } & Record<string, unknown>) => {
      const id = enc(siteId);
      const current = ((await get(`/api/web-testing/sites/${id}/config`)) as { config?: Record<string, unknown> }).config ?? {};
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (!Object.keys(defined).length) throw new Error('Nothing to update — pass at least one field.');
      if (Array.isArray(defined.targets)) {
        restoreRedactedAuth(defined.targets as { id?: string; auth?: unknown }[], (current.targets as { id?: string; auth?: unknown }[]) ?? []);
      }
      const res = (await put(`/api/web-testing/sites/${id}/config`, { config: { ...current, ...defined } })) as {
        config?: unknown;
        deployHookUrl?: string;
        nextRunAt?: string;
      };
      return { message: 'Web test config saved', config: redactTargetAuth(res.config), deployHookUrl: res.deployHookUrl ?? null, nextRunAt: res.nextRunAt ?? null };
    })
  );

  server.registerTool(
    'update_web_site',
    {
      description: 'Rename a web-test site or change its URL, repo, or Slack/Discord failure webhooks ("" clears).',
      inputSchema: {
        siteId: z.string().min(1),
        name: z.string().min(1).max(80).optional(),
        url: z.string().optional(),
        repoUrl: z.string().optional(),
        slackWebhookUrl: z.string().optional(),
        discordWebhookUrl: z.string().optional(),
      },
    },
    tool(async ({ siteId, ...fields }: { siteId: string } & Record<string, string | undefined>) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error('Nothing to update — pass at least one field.');
      return patch(`/api/web-testing/sites/${enc(siteId)}`, body);
    })
  );

  server.registerTool(
    'set_web_site_secrets',
    {
      description:
        'Set or delete web-test secrets (env vars for repo-mode builds, referenced by target repo.envKeys). ' +
        'Pass null or "" to delete a key. Other keys are kept.',
      inputSchema: {
        siteId: z.string().min(1),
        secrets: z.record(z.string().nullable()),
      },
    },
    tool(async ({ siteId, secrets }: { siteId: string; secrets: Record<string, string | null> }) =>
      put(`/api/web-testing/sites/${enc(siteId)}/secrets`, { secrets })
    )
  );

  server.registerTool(
    'validate_web_flow',
    {
      description: 'Check a no-code web flow (browser steps) and return it normalized, without saving anything.',
      inputSchema: { flow: z.record(z.unknown()) },
    },
    tool(async ({ flow }: { flow: Record<string, unknown> }) => post('/api/web-testing/flows/validate', { flow }))
  );

  server.registerTool(
    'approve_web_baseline',
    {
      description:
        'Accept a web test run\'s screenshots as the new visual-diff baseline. Omit keys to approve all; ' +
        'keys look like "desktop:/pricing" or "mobile:flow:<flowId>:<step>".',
      inputSchema: {
        siteId: z.string().min(1),
        runId: z.string().min(1),
        keys: z.array(z.string()).optional(),
      },
    },
    tool(async ({ siteId, runId, keys }: { siteId: string; runId: string; keys?: string[] }) =>
      post(`/api/web-testing/sites/${enc(siteId)}/runs/${enc(runId)}/approve-baseline`, keys ? { keys } : {})
    )
  );

  server.registerTool(
    'delete_web_site',
    {
      description:
        'Permanently delete a web-test site with all its runs, screenshots and baselines. Cannot be undone — ' +
        'confirm with the user first.',
      inputSchema: { siteId: z.string().min(1) },
    },
    tool(async ({ siteId }: { siteId: string }) => del(`/api/web-testing/sites/${enc(siteId)}`))
  );
}
