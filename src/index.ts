#!/usr/bin/env node
/**
 * Venelx MCP server — lets AI assistants operate the Venelx CI/CD platform
 * (projects, builds, logs, artifacts, workers, signing, GitHub access, and build /
 * test configuration) over stdio.
 *
 * IMPORTANT: never write to stdout — the stdio transport owns it. Log to stderr only.
 */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, apiUrl, get, post, postMultipart } from './client.js';
import { runLogin } from './login.js';
import { registerConfigTools } from './configTools.js';
import {
  discoverAndroidKeystore,
  discoverIosKeychainIdentities,
  discoverIosProvisioningProfiles,
  exportKeychainIdentitiesToP12,
  findExtensionProfiles,
  pickBestProfile,
  readFileBase64,
} from './localSigning.js';

// `npx @venelx/mcp login` — device login, then exit. Never reaches the MCP
// server below (stdout is free to use here; the stdio transport isn't up yet).
if (process.argv[2] === 'login') {
  try {
    await runLogin();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const TOKEN_SETUP_HINT =
  'Create a token at Account → API tokens (https://app.venelx.com/account/tokens).';

const server = new McpServer({
  name: 'venelx',
  version: '0.1.2',
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
      'Trigger a CI/CD build for a project on a platform (e.g. "ios" or "android-preview"). ' +
      'Optionally pick a git branch (default: the target\'s configured branch) and run the ' +
      'project\'s app-test suite (Maestro) after the build. Requires an API token with the write scope. ' +
      'Returns jobId/status/message/branch; a skipped build includes a skipReason ' +
      '(e.g. signing_not_ready, github_token_invalid, tests_not_configured).',
    inputSchema: {
      projectId: projectIdSchema,
      platform: z.string().min(1).describe('Build platform / flow id, e.g. "ios" or "android-preview"'),
      branch: z
        .string()
        .min(1)
        .optional()
        .describe('Git branch to build (omit for the target\'s default branch)'),
      runTests: z
        .boolean()
        .optional()
        .describe('Run the configured app tests after a successful build (Settings → Testing must be enabled)'),
    },
  },
  tool(
    async ({
      projectId,
      platform,
      branch,
      runTests,
    }: {
      projectId: string;
      platform: string;
      branch?: string;
      runTests?: boolean;
    }) => {
      const body: Record<string, unknown> = {};
      if (branch) body.branch = branch;
      if (runTests !== undefined) body.runTests = runTests;
      return post(
        `/api/${encodeURIComponent(projectId)}/build/${encodeURIComponent(platform)}`,
        body
      );
    }
  )
);

server.registerTool(
  'list_branches',
  {
    description:
      'List git branches of the project\'s linked repository (fetched with the project\'s own GitHub ' +
      'credentials), the project default branch, and the branch each build target uses.',
    inputSchema: {
      projectId: projectIdSchema,
      query: z.string().optional().describe('Case-insensitive substring filter'),
    },
  },
  tool(async ({ projectId, query }: { projectId: string; query?: string }) => {
    const q = query ? `?q=${encodeURIComponent(query)}` : '';
    return get(`/api/projects/${encodeURIComponent(projectId)}/repo-branches${q}`);
  })
);

server.registerTool(
  'list_web_sites',
  {
    description: 'List websites configured for Playwright web testing (standalone from app projects): name, URL, last status, schedule.',
    inputSchema: {},
  },
  tool(async () => get('/api/web-testing/sites'))
);

server.registerTool(
  'run_web_test',
  {
    description:
      'Queue a Playwright web test (site crawl, flows, visual diff) for a website. ' +
      'Optional targetId, branch (uses the target\'s branch URL template or repo branch) or an explicit URL override.',
    inputSchema: {
      siteId: z.string().min(1).describe('Website id from list_web_sites'),
      targetId: z.string().optional(),
      branch: z.string().optional(),
      url: z.string().url().optional().describe('Test this URL instead of the target URL'),
    },
  },
  tool(async ({ siteId, targetId, branch, url }: { siteId: string; targetId?: string; branch?: string; url?: string }) => {
    const body: Record<string, unknown> = {};
    if (targetId) body.targetId = targetId;
    if (branch) body.branch = branch;
    if (url) body.url = url;
    return post(`/api/web-testing/sites/${encodeURIComponent(siteId)}/runs`, body);
  })
);

server.registerTool(
  'web_test_runs',
  {
    description:
      'List recent web test runs for a website (status, pages/flows/visual-diff summary) and its configuration. ' +
      'Pass runId to get full page/flow results for one run.',
    inputSchema: {
      siteId: z.string().min(1),
      runId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  tool(async ({ siteId, runId, limit }: { siteId: string; runId?: string; limit?: number }) => {
    const id = encodeURIComponent(siteId);
    if (runId) return get(`/api/web-testing/sites/${id}/runs/${encodeURIComponent(runId)}`);
    const [runs, site] = await Promise.all([get(`/api/web-testing/sites/${id}/runs?limit=${limit ?? 20}`), get(`/api/web-testing/sites/${id}`)]);
    return { site, ...(runs as object) };
  })
);

server.registerTool(
  'test_runs',
  {
    description:
      'List recent app-test runs (Maestro etc.) for a project: status, pass/fail summary, branch, ' +
      'linked build, and failing test cases. Also returns the project test configuration.',
    inputSchema: {
      projectId: projectIdSchema,
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  tool(async ({ projectId, limit }: { projectId: string; limit?: number }) => {
    const id = encodeURIComponent(projectId);
    const [runs, config] = await Promise.all([
      get(`/api/${id}/testing/runs?limit=${limit ?? 20}`),
      get(`/api/${id}/testing/config`),
    ]);
    return { config: (config as { config?: unknown })?.config ?? null, ...(runs as object) };
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

server.registerTool(
  'discover_local_ios_signing',
  {
    description:
      'Scan THIS machine (must be a Mac) for installed iOS provisioning profiles ' +
      '(~/Library/MobileDevice/Provisioning Profiles) and Keychain code-signing identities. ' +
      'Read-only — nothing is uploaded. Use this before sync_local_ios_signing to see what is ' +
      'actually available (bundle IDs, distribution type, expiry, and whether a matching ' +
      'Distribution certificate exists in Keychain).',
    inputSchema: {},
  },
  tool(async () => {
    const [profiles, identities] = await Promise.all([
      discoverIosProvisioningProfiles(),
      discoverIosKeychainIdentities(),
    ]);
    const hasDistributionIdentity = identities.some((i) => /distribution/i.test(i.name));
    return {
      profiles: profiles.map((p) => ({
        bundleId: p.bundleId,
        name: p.name,
        distributionType: p.distributionType,
        teamId: p.teamId,
        expirationDate: p.expirationDate,
      })),
      keychainIdentities: identities.map((i) => i.name),
      hasDistributionIdentity,
      warning: hasDistributionIdentity
        ? undefined
        : 'No "Distribution" identity found in Keychain — appstore/adhoc profiles need one to ' +
          'actually sign a release build. Only a Development identity (if any) is available here.',
    };
  })
);

server.registerTool(
  'sync_local_ios_signing',
  {
    description:
      'Export the matching Distribution certificate + private key from this Mac\'s Keychain, ' +
      'pick the best local provisioning profile for the project\'s main app bundle ID (and any ' +
      'sub-bundle-ID extension profile found — share extension, etc.), and upload them to Venelx ' +
      'as this project\'s iOS signing credentials. Requires an API token with the write scope. ' +
      'NOTE: only ONE extension profile is currently supported (whichever sub-bundle-ID profile ' +
      'is found) — if multiple extension types exist (e.g. both a share extension and a widget), ' +
      'only one can be synced this way today; the response lists every extension bundle ID found ' +
      'so you can see what was and wasn\'t included.',
    inputSchema: {
      projectId: projectIdSchema,
      p12ExportPassword: z
        .string()
        .min(4)
        .describe('Password to protect the exported .p12 in transit/at rest — your choice, not an existing password'),
      bundleId: z
        .string()
        .optional()
        .describe('Main app bundle ID; auto-detected from the project\'s signing status if omitted'),
    },
  },
  tool(
    async ({
      projectId,
      p12ExportPassword,
      bundleId,
    }: {
      projectId: string;
      p12ExportPassword: string;
      bundleId?: string;
    }) => {
      let mainBundleId = bundleId;
      if (!mainBundleId) {
        const status = (await get(
          `/api/${encodeURIComponent(projectId)}/signing/status?platform=ios`
        )) as { bundleId?: string };
        mainBundleId = status.bundleId;
        if (!mainBundleId) {
          throw new Error(
            'No bundleId given and none found via signing_status — pass bundleId explicitly.'
          );
        }
      }

      const [profiles, identities] = await Promise.all([
        discoverIosProvisioningProfiles(),
        discoverIosKeychainIdentities(),
      ]);

      const mainProfile = pickBestProfile(profiles, mainBundleId);
      if (!mainProfile) {
        throw new Error(
          `No local provisioning profile found for bundle ID "${mainBundleId}". ` +
            'Run discover_local_ios_signing to see what is actually installed.'
        );
      }

      const needsDistribution = mainProfile.distributionType === 'appstore' || mainProfile.distributionType === 'adhoc';
      const hasDistributionIdentity = identities.some((i) => /distribution/i.test(i.name));
      if (needsDistribution && !hasDistributionIdentity) {
        throw new Error(
          `Selected profile "${mainProfile.name}" is ${mainProfile.distributionType}, which needs a ` +
            'Distribution certificate — but Keychain only has: ' +
            `${identities.map((i) => i.name).join(', ') || '(none)'}. Install/generate a Distribution ` +
            'certificate first (Xcode → Settings → Accounts → Manage Certificates, or the Apple ' +
            'Developer portal), then retry.'
        );
      }

      const allExtensions = findExtensionProfiles(profiles, mainBundleId, mainProfile.distributionType);
      const extensionBundleIds = Object.keys(allExtensions);
      const syncedExtensionBundleId = extensionBundleIds[0]; // only one slot supported today
      const skippedExtensionBundleIds = extensionBundleIds.slice(1);

      const p12Base64 = await exportKeychainIdentitiesToP12(p12ExportPassword);

      const fields: Record<string, string | { filename: string; base64: string }> = {
        bundleId: mainBundleId,
        teamId: mainProfile.teamId || '',
        p12Password: p12ExportPassword,
        apple_p12: { filename: 'distribution.p12', base64: p12Base64 },
        apple_provisioning: {
          filename: 'main.mobileprovision',
          base64: await readFileBase64(mainProfile.file),
        },
      };
      if (syncedExtensionBundleId) {
        fields.apple_provisioning_share = {
          filename: 'extension.mobileprovision',
          base64: await readFileBase64(allExtensions[syncedExtensionBundleId].file),
        };
      }

      const result = await postMultipart(`/api/${encodeURIComponent(projectId)}/settings/store-configs/apple`, fields);

      return {
        ...(result as Record<string, unknown>),
        mainBundleId,
        mainProfileSynced: mainProfile.name,
        extensionBundleIdSynced: syncedExtensionBundleId ?? null,
        extensionBundleIdsFoundButSkipped: skippedExtensionBundleIds,
        note:
          skippedExtensionBundleIds.length > 0
            ? `Found ${skippedExtensionBundleIds.length} more extension bundle ID(s) locally that could not be synced ` +
              `(only one extension slot supported today): ${skippedExtensionBundleIds.join(', ')}`
            : undefined,
      };
    }
  )
);

server.registerTool(
  'discover_local_android_signing',
  {
    description:
      'Scan a local project checkout\'s android/ directory for a release keystore (.jks/.keystore) ' +
      'and store/key credentials in gradle.properties. Read-only — nothing is uploaded.',
    inputSchema: {
      projectPath: z.string().min(1).describe('Absolute local filesystem path to the project checkout'),
    },
  },
  tool(async ({ projectPath }: { projectPath: string }) => {
    const found = await discoverAndroidKeystore(projectPath);
    return {
      ...found,
      readyToSync: Boolean(found.keystoreFile && found.keystorePassword && found.keyAlias),
    };
  })
);

server.registerTool(
  'sync_local_android_signing',
  {
    description:
      'Upload a local project checkout\'s release keystore (found under android/) to Venelx as this ' +
      'project\'s Android signing credentials. Requires an API token with the write scope. Store ' +
      'password / key alias / key password are auto-detected from gradle.properties when possible; ' +
      'pass them explicitly if discover_local_android_signing reports them missing.',
    inputSchema: {
      projectId: projectIdSchema,
      projectPath: z.string().min(1).describe('Absolute local filesystem path to the project checkout'),
      keystorePassword: z.string().optional().describe('Overrides the value found in gradle.properties'),
      keyAlias: z.string().optional().describe('Overrides the value found in gradle.properties'),
      keyPassword: z.string().optional().describe('Overrides the value found in gradle.properties'),
      packageName: z.string().optional(),
    },
  },
  tool(
    async ({
      projectId,
      projectPath,
      keystorePassword,
      keyAlias,
      keyPassword,
      packageName,
    }: {
      projectId: string;
      projectPath: string;
      keystorePassword?: string;
      keyAlias?: string;
      keyPassword?: string;
      packageName?: string;
    }) => {
      const found = await discoverAndroidKeystore(projectPath);
      if (!found.keystoreFile) {
        throw new Error(
          `No .jks/.keystore file found under ${projectPath}/android — run discover_local_android_signing first.`
        );
      }
      const finalStorePassword = keystorePassword ?? found.keystorePassword;
      const finalKeyAlias = keyAlias ?? found.keyAlias;
      if (!finalStorePassword || !finalKeyAlias) {
        throw new Error(
          'Missing keystorePassword or keyAlias — not found in gradle.properties and not passed explicitly.'
        );
      }

      const fields: Record<string, string | { filename: string; base64: string }> = {
        android_keystore: {
          filename: path.basename(found.keystoreFile),
          base64: await readFileBase64(found.keystoreFile),
        },
        keystorePassword: finalStorePassword,
        keyAlias: finalKeyAlias,
        keyPassword: keyPassword ?? found.keyPassword ?? finalStorePassword,
      };
      if (packageName) fields.packageName = packageName;

      const result = await postMultipart(`/api/${encodeURIComponent(projectId)}/settings/store-configs/android`, fields);
      return { ...(result as Record<string, unknown>), keystoreFileSynced: found.keystoreFile };
    }
  )
);

registerConfigTools(server, tool);

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
