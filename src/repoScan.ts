/**
 * Read-only scan of a local repo to suggest how to set it up on Venelx.
 * Never reads secret VALUES: it lists key names from .env.example/.env.sample only,
 * and only reports whether gitignored build files (google-services.json, keystores, …) exist.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type BuildStack = 'expo' | 'react_native' | 'flutter' | 'native_ios' | 'native_android' | 'unity';

export interface RepoScan {
  directory: string;
  git: { remoteUrl: string | null; githubUrl: string | null; branch: string | null };
  /** Repo-relative folder holding the app ('' = repo root). */
  rootDirectory: string;
  stack: BuildStack | null;
  stackCandidates: BuildStack[];
  platforms: ('ios' | 'android')[];
  appIds: { iosBundleId?: string; androidPackage?: string };
  easProfiles: string[];
  envKeys: string[];
  /** Files the build probably needs that are gitignored (or untracked) — ship with sync_build_files. */
  buildFiles: { path: string; exists: boolean; gitignored: boolean }[];
  notes: string[];
}

const exists = async (p: string) => stat(p).then(() => true, () => false);
const readJson = async (p: string): Promise<Record<string, any> | null> => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Remove credentials from a git remote URL (https://user:token@host/... or user@host:path). */
export function stripRemoteCredentials(remote: string | null): string | null {
  if (!remote) return null;
  const r = remote.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      return r.replace(/\/\/[^/@\s]*@/, '//');
    }
  }
  // scp-style (git@github.com:org/repo.git): the user part is not a secret, but drop anything before the last @.
  return r.replace(/^[^@\s]*@/, '');
}

/** git@github.com:org/repo.git | https://github.com/org/repo(.git) → https://github.com/org/repo */
export function normalizeGithubUrl(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

async function classify(dir: string): Promise<{ stacks: BuildStack[]; pkg: Record<string, any> | null }> {
  const stacks: BuildStack[] = [];
  const pkg = await readJson(path.join(dir, 'package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.expo) stacks.push('expo');
  else if (deps['react-native']) stacks.push('react_native');
  const pubspec = await readFile(path.join(dir, 'pubspec.yaml'), 'utf8').catch(() => '');
  if (/^\s*flutter\s*:/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec)) stacks.push('flutter');
  if (await exists(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) stacks.push('unity');
  if (!stacks.length) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'))) stacks.push('native_ios');
    if (await exists(path.join(dir, 'build.gradle')) || (await exists(path.join(dir, 'build.gradle.kts')))) {
      stacks.push('native_android');
    }
  }
  return { stacks, pkg };
}

/** Find the app folder: repo root first, then apps/*, packages/*, and top-level subfolders. */
async function findAppRoot(dir: string): Promise<{ rel: string; stacks: BuildStack[]; pkg: Record<string, any> | null }> {
  const root = await classify(dir);
  if (root.stacks.length) return { rel: '', ...root };
  const candidates: string[] = [];
  for (const parent of ['apps', 'packages', 'mobile', '']) {
    const base = path.join(dir, parent);
    for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') candidates.push(path.join(parent, e.name));
    }
  }
  for (const rel of candidates) {
    const c = await classify(path.join(dir, rel));
    if (c.stacks.length) return { rel: rel.split(path.sep).join('/'), ...c };
  }
  return { rel: '', stacks: [], pkg: root.pkg };
}

export async function scanRepo(directory: string): Promise<RepoScan> {
  const dir = path.resolve(directory);
  const notes: string[] = [];
  if (!(await exists(dir))) throw new Error(`Directory not found: ${dir}`);

  const rawRemote = await git(dir, ['remote', 'get-url', 'origin']);
  const remoteUrl = stripRemoteCredentials(rawRemote);
  const githubUrl = normalizeGithubUrl(rawRemote);
  // symbolic-ref also works before the first commit; detached HEAD yields null.
  const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (!remoteUrl) notes.push('No git "origin" remote found. Push this repo to GitHub first — Venelx builds from a GitHub repository.');
  else if (!githubUrl) notes.push(`Remote "${remoteUrl}" is not a github.com URL; Venelx currently needs a GitHub repository.`);

  const app = await findAppRoot(dir);
  const appDir = path.join(dir, app.rel);
  if (!app.stacks.length) notes.push('Could not detect a supported stack (expo, react_native, flutter, native_ios, native_android, unity).');
  if (app.stacks.length > 1) notes.push(`Several stacks match (${app.stacks.join(', ')}); pick one explicitly.`);

  const platforms: ('ios' | 'android')[] = [];
  const hasIos = (await exists(path.join(appDir, 'ios'))) || (await readdir(appDir).catch(() => [] as string[])).some((e) => e.endsWith('.xcodeproj'));
  const hasAndroid = await exists(path.join(appDir, 'android'));
  if (hasIos) platforms.push('ios');
  if (hasAndroid) platforms.push('android');

  const appJson = (await readJson(path.join(appDir, 'app.json'))) ?? {};
  const expo = (appJson.expo ?? appJson) as Record<string, any>;
  const appIds = { iosBundleId: expo?.ios?.bundleIdentifier as string | undefined, androidPackage: expo?.android?.package as string | undefined };
  if (app.stacks[0] === 'expo' && !platforms.length) {
    if (appIds.iosBundleId) platforms.push('ios');
    if (appIds.androidPackage) platforms.push('android');
    if (!platforms.length) platforms.push('ios', 'android');
  }

  const eas = await readJson(path.join(appDir, 'eas.json'));
  const easProfiles = Object.keys(eas?.build ?? {});

  const envKeys = new Set<string>();
  for (const f of ['.env.example', '.env.sample', '.env.template']) {
    const txt = await readFile(path.join(appDir, f), 'utf8').catch(() => '');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) envKeys.add(m[1]);
    }
  }
  if (await exists(path.join(appDir, '.env'))) notes.push('A local .env exists — its values were NOT read. Set needed variables with set_env_var.');

  const buildFiles: RepoScan['buildFiles'] = [];
  for (const rel of ['android/app/google-services.json', 'ios/GoogleService-Info.plist', 'android/local.properties', 'android/keystore.properties']) {
    const abs = path.join(appDir, rel);
    const present = await exists(abs);
    let ignored = false;
    if (present) {
      try {
        await run('git', ['-C', dir, 'check-ignore', '-q', abs], { timeout: 5000 });
        ignored = true; // exit 0 = ignored
      } catch {
        ignored = false;
      }
    }
    if (present) buildFiles.push({ path: path.posix.join(app.rel, rel), exists: true, gitignored: ignored });
  }
  if (buildFiles.some((f) => f.gitignored)) {
    notes.push('Some build files are gitignored; builds on Venelx will fail without them. Use sync_build_files.');
  }

  return {
    directory: dir,
    git: { remoteUrl, githubUrl, branch },
    rootDirectory: app.rel,
    stack: app.stacks.length === 1 ? app.stacks[0] : null,
    stackCandidates: app.stacks,
    platforms,
    appIds,
    easProfiles,
    envKeys: [...envKeys].sort(),
    buildFiles,
    notes,
  };
}
