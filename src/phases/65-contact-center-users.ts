/**
 * Phase 65 — Add the user to the contact center.
 *
 * ============================================================================================
 * WHY THIS IS NOT A BROWSER PHASE
 * ============================================================================================
 * The documented route is Setup → the contact center → Contact Center Users → Add → pick the user →
 * Done. That is not necessary: `User.CallCenterId` is a plain updateable reference field, so the
 * whole interaction reduces to one record update.
 *
 * VERIFIED rather than assumed — `sf sobject describe -s User` reports `CallCenterId` with
 * `updateable: true`, and setting it succeeded and read back correctly:
 *
 *     sf data update record -s User -i <userId> -v "CallCenterId=<callCenterId>"
 *     → SELECT Username, CallCenterId FROM User  →  04vO8000003sS41IAE
 *
 * If someone later "fixes" this by adding browser automation for the Add User dialog, they will be
 * adding a slower and more fragile version of a working one-liner.
 * ============================================================================================
 */

import { query, sf } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

export const contactCenterUsersPhase: Phase = {
  id: 'contact-center-users',
  title: 'Add the user to the contact center',

  enabled: (ctx) => ctx.config.contactCenter.create,

  async run(ctx: PhaseContext) {
    const org = requireOrg(ctx);
    const internalName = ctx.config.contactCenter.internalName;

    const callCenters = await query<{ Id: string }>(
      org.username,
      `SELECT Id FROM CallCenter WHERE InternalName = '${internalName}'`,
    );
    const callCenterId = callCenters.records[0]?.Id;

    if (!callCenterId) {
      ctx.log.warn(`Contact center "${internalName}" does not exist — nothing to add the user to`);
      return;
    }

    const users = await query<{ Id: string; CallCenterId: string | null }>(
      org.username,
      `SELECT Id, CallCenterId FROM User WHERE Username = '${org.username}'`,
    );
    const user = users.records[0];

    if (!user) {
      throw new Error(`Could not find the running user (${org.username}) to assign.`);
    }

    if (user.CallCenterId === callCenterId) {
      ctx.log.skip(`${org.username} is in contact center "${internalName}"`);
      ctx.facts['Contact center user'] = org.username;
      return;
    }

    await sf(
      [
        'data',
        'update',
        'record',
        '--target-org',
        org.username,
        '--sobject',
        'User',
        '--record-id',
        user.Id,
        '--values',
        `CallCenterId=${callCenterId}`,
      ],
      { onCommand: (c) => ctx.log.command(c) },
    );

    ctx.log.success(`Added ${org.username} to contact center "${internalName}"`);
    ctx.facts['Contact center user'] = org.username;
  },
};
