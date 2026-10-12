import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = ['index.ts', 'configTools.ts', 'projectTools.ts']
  .map((f) => readFileSync(join(here, '..', 'src', f), 'utf8'))
  .join('\n');
const registered = new Set([...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
const docs = readFileSync(join(here, '..', '..', 'venelx-docs', 'content', 'mcp.mdx'), 'utf8');

test('registered tool names are discovered', () => {
  for (const n of ['create_project', 'detect_project_setup', 'trigger_build', 'sync_build_files']) assert.ok(registered.has(n), n);
});

test('the canonical AI setup prompt only references tools that exist', () => {
  const prompt = readFileSync(join(here, '..', '..', 'venelx-docs', 'public', 'ai-setup-prompt.txt'), 'utf8');
  assert.match(prompt, /^Set up this repository on Venelx/);
  const mentioned = new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
  const fieldNames = new Set(['env_keys']);
  const unknown = [...mentioned].filter((w) => !registered.has(w) && !fieldNames.has(w));
  assert.deepEqual(unknown, []);
});

test('every tool listed in the docs tables or lists exists', () => {
  const listed = [...docs.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
  const notTools = new Set(['teamId']);
  const unknown = [...new Set(listed)].filter((w) => !registered.has(w) && !notTools.has(w) && !/^(signing_not_ready|github_token_invalid)$/.test(w));
  assert.deepEqual(unknown, []);
});
