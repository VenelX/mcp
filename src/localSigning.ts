/**
 * Local iOS/Android signing material discovery — reads THIS machine's
 * Keychain, provisioning profiles, and (given a project checkout path)
 * Android keystore, so it can be synced to Venelx without the user manually
 * copying files around. Everything here runs locally; nothing is uploaded
 * from this module (see index.ts's sync_* tools for the upload step).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── iOS: provisioning profiles ────────────────────────────────────────────

export type ProvisioningProfile = {
  file: string;
  name: string;
  bundleId: string | null;
  teamId: string | null;
  expirationDate: string | null;
  distributionType: 'appstore' | 'adhoc' | 'development' | 'enterprise' | 'unknown';
  developerCertificatesB64: string[];
};

const PROFILES_DIR = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');

async function decodeProfilePlist(file: string): Promise<string> {
  const { stdout } = await execFileAsync('security', ['cms', '-D', '-i', file]);
  return stdout;
}

async function plutilExtract(plistPath: string, keyPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('plutil', ['-extract', keyPath, 'raw', '-o', '-', plistPath]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function plutilExtractArray(plistPath: string, keyPath: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const v = await plutilExtract(plistPath, `${keyPath}.${i}`);
    if (v === null) break;
    out.push(v);
  }
  return out;
}

async function inferDistributionType(
  plistPath: string,
  getTaskAllow: string | null
): Promise<ProvisioningProfile['distributionType']> {
  const provisionsAll = await plutilExtract(plistPath, 'ProvisionsAllDevices');
  if (provisionsAll === 'true' || provisionsAll === '1') return 'enterprise';
  const hasDevices = (await plutilExtract(plistPath, 'ProvisionedDevices.0')) !== null;
  if (hasDevices) return getTaskAllow === 'true' ? 'development' : 'adhoc';
  return 'appstore';
}

/** Every locally-installed .mobileprovision, decoded. Skips files that fail to decode (corrupt/unrelated). */
export async function discoverIosProvisioningProfiles(): Promise<ProvisioningProfile[]> {
  let entries: string[];
  try {
    entries = (await fs.promises.readdir(PROFILES_DIR)).filter((f) => f.endsWith('.mobileprovision'));
  } catch {
    return [];
  }

  const profiles: ProvisioningProfile[] = [];
  for (const entry of entries) {
    const file = path.join(PROFILES_DIR, entry);
    const tmpPlist = path.join(os.tmpdir(), `venelx-mcp-profile-${Date.now()}-${Math.random().toString(36).slice(2)}.plist`);
    try {
      const decoded = await decodeProfilePlist(file);
      await fs.promises.writeFile(tmpPlist, decoded, 'utf8');
      const name = (await plutilExtract(tmpPlist, 'Name')) || entry;
      const bundleId = await plutilExtract(tmpPlist, 'Entitlements.application-identifier');
      const teamId = await plutilExtract(tmpPlist, 'TeamIdentifier.0');
      const expirationDate = await plutilExtract(tmpPlist, 'ExpirationDate');
      const getTaskAllow = await plutilExtract(tmpPlist, 'Entitlements.get-task-allow');
      const distributionType = await inferDistributionType(tmpPlist, getTaskAllow);
      const developerCertificatesB64 = await plutilExtractArray(tmpPlist, 'DeveloperCertificates');

      // bundleId comes back as "<teamPrefix>.<real.bundle.id>" — strip the prefix.
      const strippedBundleId =
        bundleId && teamId && bundleId.startsWith(`${teamId}.`) ? bundleId.slice(teamId.length + 1) : bundleId;

      profiles.push({
        file,
        name,
        bundleId: strippedBundleId,
        teamId,
        expirationDate,
        distributionType,
        developerCertificatesB64,
      });
    } catch {
      // Not a valid/decodable provisioning profile — skip it.
    } finally {
      await fs.promises.rm(tmpPlist, { force: true });
    }
  }
  return profiles;
}

// ─── iOS: Keychain identities ───────────────────────────────────────────────

export type KeychainIdentity = { hash: string; name: string };

export async function discoverIosKeychainIdentities(): Promise<KeychainIdentity[]> {
  try {
    const { stdout } = await execFileAsync('security', ['find-identity', '-v', '-p', 'codesigning']);
    const identities: KeychainIdentity[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*\d+\)\s+([0-9A-F]+)\s+"(.+)"$/);
      if (m) identities.push({ hash: m[1], name: m[2] });
    }
    return identities;
  } catch {
    return [];
  }
}

/** Pick the best profile for an exact bundle ID: prefer appstore, then newest expiration. */
export function pickBestProfile(
  profiles: ProvisioningProfile[],
  bundleId: string,
  preferType: ProvisioningProfile['distributionType'] = 'appstore'
): ProvisioningProfile | null {
  const matching = profiles.filter((p) => p.bundleId === bundleId);
  if (matching.length === 0) return null;
  const byType = matching.filter((p) => p.distributionType === preferType);
  const pool = byType.length > 0 ? byType : matching;
  return pool.sort((a, b) => String(b.expirationDate ?? '').localeCompare(String(a.expirationDate ?? '')))[0];
}

/** Other profiles whose bundle ID is a sub-identifier of the main app (extensions, widgets, etc). */
export function findExtensionProfiles(
  profiles: ProvisioningProfile[],
  mainBundleId: string,
  preferType: ProvisioningProfile['distributionType'] = 'appstore'
): Record<string, ProvisioningProfile> {
  const prefix = `${mainBundleId}.`;
  const extensionBundleIds = new Set(
    profiles.filter((p) => p.bundleId?.startsWith(prefix)).map((p) => p.bundleId as string)
  );
  const result: Record<string, ProvisioningProfile> = {};
  for (const bundleId of extensionBundleIds) {
    const best = pickBestProfile(profiles, bundleId, preferType);
    if (best) result[bundleId] = best;
  }
  return result;
}

/** Export every codesigning identity in the login keychain to one .p12 (deleted by the caller). */
export async function exportKeychainIdentitiesToP12(exportPassword: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `venelx-mcp-export-${Date.now()}-${Math.random().toString(36).slice(2)}.p12`);
  try {
    await execFileAsync('security', [
      'export',
      '-t',
      'identities',
      '-f',
      'pkcs12',
      '-P',
      exportPassword,
      '-o',
      tmpFile,
    ]);
    const buf = await fs.promises.readFile(tmpFile);
    return buf.toString('base64');
  } finally {
    await fs.promises.rm(tmpFile, { force: true });
  }
}

// ─── Android: keystore + gradle.properties ─────────────────────────────────

export type AndroidKeystoreDiscovery = {
  keystoreFile: string | null;
  keystorePassword: string | null;
  keyAlias: string | null;
  keyPassword: string | null;
};

const GRADLE_PROP_PATTERNS = {
  storePassword: /^.*(?:STORE_PASSWORD|storePassword)\s*=\s*(.+)$/im,
  keyAlias: /^.*(?:KEY_ALIAS|keyAlias)\s*=\s*(.+)$/im,
  keyPassword: /^.*(?:KEY_PASSWORD|keyPassword)\s*=\s*(.+)$/im,
};

/** Scan a project checkout's android/ dir for a keystore + credentials in gradle.properties. */
export async function discoverAndroidKeystore(projectPath: string): Promise<AndroidKeystoreDiscovery> {
  const androidDir = path.join(projectPath, 'android');
  const candidates = [path.join(androidDir, 'app'), androidDir];

  let keystoreFile: string | null = null;
  for (const dir of candidates) {
    try {
      const files = await fs.promises.readdir(dir);
      const match = files.find((f) => f.endsWith('.jks') || f.endsWith('.keystore'));
      if (match) {
        keystoreFile = path.join(dir, match);
        break;
      }
    } catch {
      // dir doesn't exist — keep looking
    }
  }

  let storePassword: string | null = null;
  let keyAlias: string | null = null;
  let keyPassword: string | null = null;
  try {
    const props = await fs.promises.readFile(path.join(androidDir, 'gradle.properties'), 'utf8');
    storePassword = props.match(GRADLE_PROP_PATTERNS.storePassword)?.[1]?.trim() ?? null;
    keyAlias = props.match(GRADLE_PROP_PATTERNS.keyAlias)?.[1]?.trim() ?? null;
    keyPassword = props.match(GRADLE_PROP_PATTERNS.keyPassword)?.[1]?.trim() ?? null;
  } catch {
    // no gradle.properties — credentials must come from the caller
  }

  return { keystoreFile, keystorePassword: storePassword, keyAlias, keyPassword };
}

export async function readFileBase64(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  return buf.toString('base64');
}
