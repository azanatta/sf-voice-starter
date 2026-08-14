/**
 * Phase 40 — Assign the Voice permission set license and permission sets to the running user.
 *
 * Pure CLI — there is no reason to open a browser for this. `sf org assign permset` and
 * `sf org assign permsetlicense` are reliable and give clear errors.
 *
 * ORDERING: this phase must run after phase 30. The `ContactCenter*ExternalTelephony` permission sets
 * do not exist in an org until Voice is enabled — the platform creates them as a side effect of
 * enablement. Verified empirically: orgs without Voice return zero rows for those names, while a
 * Partner Telephony org returns all three. A "permission set not found" error here therefore means
 * enablement silently failed, not that the API name is wrong.
 */

import { query, sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

export const permissionsPhase: Phase = {
  id: 'permissions',
  title: 'Assign Voice permission set license and permission sets',

  async run(ctx: PhaseContext) {
    await assignPermissionSetLicense(ctx);
    await assignPermissionSets(ctx);
  },
};

/**
 * Assigns the Partner Telephony permission set license.
 *
 * The PSL only exists if the org was provisioned with the `ServiceCloudVoicePartnerTelephony` scratch
 * org feature. When the Dev Hub is not entitled to that feature (see phase 10), the PSL is absent and
 * this is reported as a manual follow-up rather than a hard failure — the org is still usable for
 * package installation, just not for adding many Voice users.
 */
async function assignPermissionSetLicense(ctx: PhaseContext): Promise<void> {
  const org = requireOrg(ctx);
  const psl = ctx.config.voice.permissionSetLicense;

  const available = await query<{ DeveloperName: string; TotalLicenses: number }>(
    org.username,
    `SELECT DeveloperName, TotalLicenses FROM PermissionSetLicense WHERE DeveloperName = '${psl}'`,
  );

  if (available.totalSize === 0) {
    ctx.log.warn(`Permission set license "${psl}" is not provisioned in this org`);
    ctx.manualSteps.push(
      `The "${psl}" permission set license is absent, so Voice user licenses cannot be assigned. ` +
        `This happens when the scratch org was created without the ServiceCloudVoicePartnerTelephony ` +
        `feature. Recreate the org once the Dev Hub is entitled — the feature list lives in ` +
        `config/project-scratch-def.json.`,
    );
    return;
  }

  ctx.log.step(`Permission set license "${psl}" available (${available.records[0]?.TotalLicenses ?? '?'} licenses)`);

  try {
    await sf(
      ['org', 'assign', 'permsetlicense', '--target-org', org.username, '--name', psl],
      { onCommand: (c) => ctx.log.command(c) },
    );
    ctx.log.success(`Assigned permission set license "${psl}"`);
  } catch (error) {
    if (isAlreadyAssigned(error)) {
      ctx.log.skip(`Permission set license "${psl}" assigned`);
      return;
    }
    throw error;
  }
}

async function assignPermissionSets(ctx: PhaseContext): Promise<void> {
  const org = requireOrg(ctx);
  const names = ctx.config.voice.permissionSets;

  // Check existence up front so a missing permission set produces one accurate diagnosis rather than
  // three confusing CLI errors.
  const quoted = names.map((name) => `'${name}'`).join(', ');
  const present = await query<{ Name: string }>(
    org.username,
    `SELECT Name FROM PermissionSet WHERE Name IN (${quoted})`,
  );
  const presentNames = new Set(present.records.map((record) => record.Name));
  const missing = names.filter((name) => !presentNames.has(name));

  if (missing.length > 0) {
    throw new Error(
      `These Voice permission sets do not exist in ${org.username}: ${missing.join(', ')}\n` +
        `They are created by the platform when Voice is enabled, so their absence means enablement ` +
        `did not take effect. Re-run with --only=enable-voice --headed to watch what Setup does.`,
    );
  }

  for (const name of names) {
    try {
      await sf(
        ['org', 'assign', 'permset', '--target-org', org.username, '--name', name],
        { onCommand: (c) => ctx.log.command(c) },
      );
      ctx.log.success(`Assigned "${name}"`);
    } catch (error) {
      if (isAlreadyAssigned(error)) {
        ctx.log.skip(`"${name}" assigned`);
        continue;
      }
      throw error;
    }
  }

  ctx.facts['Voice permission sets'] = names.join(', ');
}

/**
 * Distinguishes "already assigned" from a real failure.
 *
 * The CLI treats a duplicate assignment as an error, which would make re-running this script fail on
 * an org it already configured. Idempotency depends on recognising it.
 */
function isAlreadyAssigned(error: unknown): boolean {
  if (!(error instanceof SfCommandError)) return false;

  // The useful text is NOT in the top-level message. `sf org assign permset` reports a duplicate as
  // status 1 with an empty top-level message and the detail buried in
  // `result.failures[].message` ("Duplicate PermissionSetAssignment. Assignee: … Permission Set: …"),
  // so a check against `error.message` alone sees only "sf command failed" and wrongly treats a
  // re-run as fatal. Serialising the whole payload catches it wherever the CLI decides to put it.
  const haystack = [
    error.errorName ?? '',
    error.message,
    typeof error.payload === 'string' ? error.payload : JSON.stringify(error.payload ?? ''),
  ]
    .join(' ')
    .toLowerCase();

  return (
    haystack.includes('duplicate') ||
    haystack.includes('already assigned') ||
    haystack.includes('already has')
  );
}
