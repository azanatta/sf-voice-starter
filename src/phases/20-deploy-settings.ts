/**
 * Phase 20 — Deploy org settings metadata.
 *
 * Deploys `force-app/`, which holds the Omni-Channel and Service Cloud Voice settings, the Online and
 * Busy presence statuses, and the permission set that grants those statuses to a rep.
 *
 * This is the phase that actually ENABLES Voice: deploying
 * `ServiceCloudVoiceSettings.enableSCVExternalTelephony = true` works, verified on a fresh org.
 *
 * It is nevertheless best-effort. A failure is logged and the run continues, because phase 30
 * verifies enablement independently and can repair it through the Setup toggle. Nothing downstream is
 * allowed to depend on this phase reporting success — only on phase 30's verification.
 */

import { sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

interface DeployResult {
  status: string;
  success: boolean;
  details?: {
    componentFailures?: Array<{ fullName?: string; componentType?: string; problem?: string }>;
  };
}

export const deploySettingsPhase: Phase = {
  id: 'deploy-settings',
  title: 'Deploy settings, presence statuses and permission sets',

  async run(ctx: PhaseContext) {
    const org = requireOrg(ctx);

    try {
      const result = await sf<DeployResult>(
        [
          'project',
          'deploy',
          'start',
          '--target-org',
          org.username,
          // The whole package directory, not just settings/. It also carries the Online/Busy presence
          // statuses and the permission set that grants them — all of which must exist before the
          // contact center XML can be rendered with their ids.
          '--source-dir',
          'force-app',
          '--wait',
          '20',
          // Settings deploys have no tests to run and the default level slows the deploy down for
          // no benefit in a scratch org.
          '--test-level',
          'NoTestRun',
        ],
        { timeoutMs: 25 * 60_000, onCommand: (c) => ctx.log.command(c) },
      );

      if (result.success) {
        ctx.log.success('Settings deployed');
      } else {
        reportComponentFailures(ctx, result);
      }
    } catch (error) {
      // Tolerated: see the file header. Phase 30 is the authority on whether Voice is actually on.
      const detail = error instanceof SfCommandError ? error.message : String(error);
      ctx.log.warn(`Settings deploy did not complete cleanly: ${detail}`);
      ctx.log.warn('Continuing — the enable-voice phase verifies the real state and can repair it.');

      if (error instanceof SfCommandError) {
        const payload = error.payload as { result?: DeployResult } | undefined;
        if (payload?.result) reportComponentFailures(ctx, payload.result);
      }
    }
  },
};

/** Surfaces per-component problems, which are far more useful than the top-level deploy message. */
function reportComponentFailures(ctx: PhaseContext, result: DeployResult): void {
  const failures = result.details?.componentFailures ?? [];
  if (failures.length === 0) {
    ctx.log.warn(`Deploy status: ${result.status} (no component-level detail returned)`);
    return;
  }
  for (const failure of failures) {
    ctx.log.warn(`${failure.componentType ?? 'Component'} ${failure.fullName ?? ''}: ${failure.problem ?? 'unknown problem'}`);
  }
}
