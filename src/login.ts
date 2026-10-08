/**
 * Browser-approved device login — `npx @venelx/mcp login`.
 * Starts a session, opens the approval page in the user's browser, polls
 * until approved, and saves the resulting token to ~/.venelx/mcp-token.
 * No copy-pasting a token into JSON config required.
 */
import { execFile } from 'node:child_process';
import { apiUrl, saveToken, TOKEN_FILE } from './client.js';

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000;

type StartResponse = { sessionId: string; verificationUrl: string; expiresInSeconds: number };
type PollResponse = { status: 'pending' | 'approved' | 'denied' | 'expired'; token?: string };

function openInBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    execFile(cmd, args, () => {
      /* best-effort — the URL is printed either way */
    });
  } catch {
    // ignore — user can click the printed link
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLogin(): Promise<void> {
  const startRes = await fetch(`${apiUrl()}/api/cli-auth/start`, { method: 'POST' });
  if (!startRes.ok) {
    throw new Error(`Could not start login (HTTP ${startRes.status}) against ${apiUrl()}`);
  }
  const start = (await startRes.json()) as StartResponse;

  console.log(`Opening ${start.verificationUrl}`);
  console.log('Approve access in your browser to finish (waiting up to 5 minutes)...');
  openInBrowser(start.verificationUrl);

  const deadline = Date.now() + Math.min(MAX_WAIT_MS, start.expiresInSeconds * 1000);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${apiUrl()}/api/cli-auth/poll/${start.sessionId}`);
    if (pollRes.status === 404) {
      throw new Error('Login session expired. Run `npx @venelx/mcp login` again.');
    }
    const poll = (await pollRes.json()) as PollResponse;
    if (poll.status === 'approved' && poll.token) {
      saveToken(poll.token);
      console.log(`Signed in. Token saved to ${TOKEN_FILE}`);
      console.log('You can now use `venelx-mcp` without setting VENELX_TOKEN.');
      return;
    }
    if (poll.status === 'denied') {
      throw new Error('Access was denied in the browser.');
    }
    if (poll.status === 'expired') {
      throw new Error('Login session expired. Run `npx @venelx/mcp login` again.');
    }
  }
  throw new Error('Timed out waiting for approval. Run `npx @venelx/mcp login` again.');
}
