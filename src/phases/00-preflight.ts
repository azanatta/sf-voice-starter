/**
 * Phase 00 — Preflight.
 *
 * Fails fast, with actionable messages, on the things that would otherwise fail confusingly twenty
 * minutes into a run. Every check here answers "is the environment capable of finishing?".
 */

import { sf, sfOptional, SfCommandError } from '../sf.js';
import type { Phase, PhaseContext } from '../types.js';

interface OrgListResult {
  devHubs?: Array<{ alias?: string; username: string; connectedStatus?: string }>;
  nonScratchOrgs?: Array<{ alias?: string; username: string; isDevHub?: boolean; connectedStatus?: string }>;
  other?: Array<{ alias?: string; username: string; isDevHub?: boolean; connectedStatus?: string }>;
  scratchOrgs?: Array<{ alias?: string; username: string; expirationDate?: string }>;
}

export const preflightPhase: Phase = {
  id: 'preflight',
  title: 'Verify tooling and Dev Hub authentication',

  async run(ctx: PhaseContext) {
    await checkCli(ctx);
    await checkDevHub(ctx);
  },
};

async function checkCli(ctx: PhaseContext): Promise<void> {
  const version = await sfOptional<{ cliVersion?: string; nodeVersion?: string }>(['version']);
  if (!version) {
    throw new Error(
      'The `sf` CLI is not installed or not on PATH.\n' +
        'Install it with:  npm install --global @salesforce/cli',
    );
  }
  ctx.log.success(`Salesforce CLI ${version.cliVersion ?? 'present'}`);
  ctx.facts['Salesforce CLI'] = version.cliVersion ?? 'unknown';
}

/**
 * Confirms the configured Dev Hub is authenticated *and* that its session still refreshes.
 *
 * The distinction matters: `sf org list` happily lists Dev Hubs whose refresh token has expired, and
 * scratch org creation against one of those fails with an authentication error that reads like a
 * permissions problem. Checking `connectedStatus` here turns that into a one-line fix.
 */
async function checkDevHub(ctx: PhaseContext): Promise<void> {
  const alias = ctx.config.devHub.alias;
  const list = await sfOptional<OrgListResult>(['org', 'list']);

  const candidates = [
    ...(list?.devHubs ?? []),
    ...(list?.nonScratchOrgs ?? []),
    ...(list?.other ?? []),
  ].filter((org) => (org as { isDevHub?: boolean }).isDevHub !== false);

  const match = candidates.find((org) => org.alias === alias || org.username === alias);

  if (!match) {
    const available = candidates
      .map((org) => `  - ${org.alias ?? '(no alias)'}  ${org.username}  [${org.connectedStatus ?? '?'}]`)
      .join('\n');
    throw new Error(
      `Dev Hub "${alias}" is not authenticated.\n` +
        `Authenticate it with:\n` +
        `  sf org login web --set-default-dev-hub --alias ${alias}\n` +
        (available ? `\nCurrently authenticated Dev Hubs:\n${available}` : ''),
    );
  }

  if (match.connectedStatus && match.connectedStatus !== 'Connected') {
    throw new Error(
      `Dev Hub "${alias}" is authenticated but its session is not usable: ${match.connectedStatus}\n` +
        `Re-authenticate with:\n` +
        `  sf org login web --set-default-dev-hub --alias ${alias}`,
    );
  }

  // `org list` can report a stale "Connected" from cache, so confirm against `org display`.
  //
  // CAUTION: `sf org display` EXITS 0 for an org whose refresh token has expired — the failure shows
  // up only in `connectedStatus`. So a try/catch around it is not a connectivity check; the status
  // field has to be read explicitly.
  try {
    const displayed = await sf<{ connectedStatus?: string }>(
      ['org', 'display', '--target-org', alias],
      { onCommand: (c) => ctx.log.command(c) },
    );
    if (displayed.connectedStatus && displayed.connectedStatus !== 'Connected') {
      throw new Error(displayed.connectedStatus);
    }
  } catch (error) {
    const detail = error instanceof SfCommandError ? error.message : String(error);
    throw new Error(
      `Dev Hub "${alias}" failed a live connectivity check: ${detail}\n` +
        `Re-authenticate with:  sf org login web --set-default-dev-hub --alias ${alias}`,
    );
  }

  ctx.log.success(`Dev Hub "${alias}" authenticated (${match.username})`);
  ctx.facts['Dev Hub'] = match.username;
}
