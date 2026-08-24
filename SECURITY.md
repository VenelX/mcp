# Security policy

## Reporting a vulnerability

Email **security@venelx.com** with details and reproduction steps. Please do not
open public issues for security reports. We aim to respond within 72 hours.

## Scope

- Released installers and self-update payloads distributed from this repo's
  Releases.
- The Venelx platform API they connect to (`api.venelx.com`).

## Notes for self-hosters

- Update payloads are SHA-256-verified before applying; the updater refuses
  unsigned or mismatched downloads.
- All credentials live outside the install/payload directories
  (`~/.venelx/*.env`, mode 0600) and are never embedded in release artifacts.
  Releases are additionally secret-scanned in CI before publishing.
- Workers need **outbound HTTPS only** — never open inbound ports.
