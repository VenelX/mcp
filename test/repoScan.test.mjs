import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeGithubUrl, scanRepo, stripRemoteCredentials } from '../dist/repoScan.js';
import { WORKER_INSTALL_COMMANDS } from '../dist/projectTools.js';

function repo(files, { remote } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-scan-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test('normalizeGithubUrl handles ssh, https and .git forms', () => {
  assert.equal(normalizeGithubUrl('git@github.com:acme/app.git'), 'https://github.com/acme/app');
  assert.equal(normalizeGithubUrl('https://github.com/acme/app.git'), 'https://github.com/acme/app');
  assert.equal(normalizeGithubUrl('https://github.com/acme/app'), 'https://github.com/acme/app');
  assert.equal(normalizeGithubUrl('https://gitlab.com/acme/app'), null);
  assert.equal(normalizeGithubUrl(null), null);
});

test('expo app: stack, git info, platforms, ids, eas profiles, env key NAMES only', async () => {
  const dir = repo(
    {
      'package.json': JSON.stringify({ dependencies: { expo: '~52', react: '18' } }),
      'app.json': JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.acme.app' }, android: { package: 'com.acme.app' } } }),
      'eas.json': JSON.stringify({ build: { development: {}, production: {} } }),
      '.env.example': 'API_URL=https://x\nSENTRY_DSN=\n# comment\nexport FLAG=1\n',
      '.env': 'SECRET_TOKEN=supersecretvalue\n',
    },
    { remote: 'git@github.com:acme/app.git' },
  );
  const s = await scanRepo(dir);
  assert.equal(s.stack, 'expo');
  assert.equal(s.git.githubUrl, 'https://github.com/acme/app');
  assert.equal(s.git.branch, 'main');
  assert.deepEqual(s.platforms, ['ios', 'android']);
  assert.equal(s.appIds.iosBundleId, 'com.acme.app');
  assert.deepEqual(s.easProfiles, ['development', 'production']);
  assert.deepEqual(s.envKeys, ['API_URL', 'FLAG', 'SENTRY_DSN']);
  assert.ok(!JSON.stringify(s).includes('supersecretvalue'), 'must never leak .env values');
  assert.ok(s.notes.some((n) => n.includes('.env')));
});

test('react-native without expo, flutter and unity are distinguished', async () => {
  assert.equal((await scanRepo(repo({ 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.76' } }) }))).stack, 'react_native');
  assert.equal((await scanRepo(repo({ 'pubspec.yaml': 'name: x\ndependencies:\n  flutter:\n    sdk: flutter\n' }))).stack, 'flutter');
  assert.equal((await scanRepo(repo({ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022' }))).stack, 'unity');
});

test('monorepo: finds the app folder and reports rootDirectory', async () => {
  const dir = repo({
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    'apps/mobile/package.json': JSON.stringify({ dependencies: { expo: '~52' } }),
    'apps/mobile/ios/Podfile': '',
  });
  const s = await scanRepo(dir);
  assert.equal(s.stack, 'expo');
  assert.equal(s.rootDirectory, 'apps/mobile');
  assert.ok(s.platforms.includes('ios'));
});

test('gitignored build files are flagged for sync_build_files', async () => {
  const dir = repo({
    'package.json': JSON.stringify({ dependencies: { 'react-native': '0.76' } }),
    '.gitignore': 'google-services.json\nlocal.properties\n',
    'android/app/google-services.json': '{}',
    'android/local.properties': 'sdk.dir=/x',
    'android/build.gradle': '',
  });
  const s = await scanRepo(dir);
  const gs = s.buildFiles.find((f) => f.path.endsWith('google-services.json'));
  assert.ok(gs && gs.gitignored, 'google-services.json should be flagged gitignored');
  assert.ok(s.notes.some((n) => n.includes('sync_build_files')));
});

test('no remote and unknown stack produce actionable notes, not errors', async () => {
  const s = await scanRepo(repo({ 'README.md': 'hi' }));
  assert.equal(s.stack, null);
  assert.ok(s.notes.some((n) => /origin/.test(n)));
  assert.ok(s.notes.some((n) => /supported stack/.test(n)));
});

test('missing directory rejects', async () => {
  await assert.rejects(scanRepo('/definitely/not/here'), /not found/);
});

test('worker install commands point at get.venelx.com', () => {
  assert.equal(WORKER_INSTALL_COMMANDS.macosLinux, 'curl -fsSL https://get.venelx.com | sh');
  assert.equal(WORKER_INSTALL_COMMANDS.windowsPowerShell, 'irm https://get.venelx.com/win | iex');
});

test('remote URLs never leak embedded credentials', async () => {
  assert.equal(stripRemoteCredentials('https://user:ghp_secret123@github.com/acme/app.git'), 'https://github.com/acme/app.git');
  assert.equal(stripRemoteCredentials('https://ghp_onlytoken@github.com/acme/app'), 'https://github.com/acme/app');
  assert.equal(stripRemoteCredentials('git@github.com:acme/app.git'), 'github.com:acme/app.git');
  assert.equal(stripRemoteCredentials(null), null);
  const dir = repo({ 'package.json': JSON.stringify({ dependencies: { expo: '1' } }) }, { remote: 'https://user:ghp_leakme999@github.com/acme/app.git' });
  const s = await scanRepo(dir);
  assert.ok(!JSON.stringify(s).includes('ghp_leakme999'), 'token must not appear anywhere in the scan result');
  assert.equal(s.git.githubUrl, 'https://github.com/acme/app');
  const bad = await scanRepo(repo({ 'README.md': 'x' }, { remote: 'https://user:ghp_leakme999@gitlab.com/acme/app.git' }));
  assert.ok(!JSON.stringify(bad).includes('ghp_leakme999'), 'token must not leak via the non-GitHub note either');
});
