/**
 * Phase 50 — Install the vendor's Service Cloud Voice managed package.
 *
 * Pure CLI. `sf package install` is the supported path and handles the long-running install job for
 * us; automating the AppExchange install page in a browser would be strictly worse.
 *
 * This phase is skipped when no package is configured. That is a legitimate and common way to use
 * this script: everything before it leaves the org in the "ready to install a SCV package" state, so
 * you can install by hand or point a different pipeline at it.
 */

import { query, sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

export const installPackagePhase: Phase = {
  id: 'install-package',
  title: 'Install the Service Cloud Voice managed package',

  enabled: (ctx) => ctx.config.package.versionId.trim() !== '',

  async run(ctx: PhaseContext) {
    const org = requireOrg(ctx);
    const versionId = extractVersionId(ctx.config.package.versionId);

    if (await isAlreadyInstalled(ctx, versionId)) {
      ctx.log.skip(`Package version ${versionId} is installed`);
      ctx.facts['SCV package'] = `${versionId} (already installed)`;
      return;
    }

    const args = [
      'package',
      'install',
      '--target-org',
      org.username,
      '--package',
      versionId,
      '--wait',
      String(ctx.config.package.waitMinutes),
      // Without this the CLI stops and prompts, which hangs an unattended run forever.
      '--no-prompt',
      '--security-type',
      ctx.config.package.securityType,
      // Upgrade type only matters for reinstalls, but setting it explicitly avoids a surprise if the
      // script is pointed at an org that already has an older version.
      '--upgrade-type',
      'Mixed',
      // The install job itself can outlive the CLI's default publish wait on large packages.
      '--publish-wait',
      String(ctx.config.package.waitMinutes),
    ];

    if (ctx.config.package.installationKey.trim() !== '') {
      args.push('--installation-key', ctx.config.package.installationKey);
    }

    ctx.log.step(`Installing ${versionId} (up to ${ctx.config.package.waitMinutes} minutes)`);
    try {
      await sf(args, {
        // Generous: managed SCV packages are large and installs of 20+ minutes are normal.
        timeoutMs: (ctx.config.package.waitMinutes + 10) * 60_000,
        onCommand: (c) => ctx.log.command(c),
      });
    } catch (error) {
      throw new Error(buildInstallDiagnosis(error, versionId, ctx));
    }

    ctx.log.success(`Installed package version ${versionId}`);
    ctx.facts['SCV package'] = versionId;
  },
};

/**
 * Accepts either a bare `04t…` id or a full install URL and returns the id.
 *
 * Vendors hand out install links far more often than raw ids, and pasting the link is the natural
 * thing to do — so accept it rather than making the user parse it.
 */
export function extractVersionId(input: string): string {
  const trimmed = input.trim();
  if (/^04t[a-zA-Z0-9]{12,15}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/04t[a-zA-Z0-9]{12,15}/);
  if (match) return match[0];

  throw new Error(
    `Could not find a package version id in "${input}".\n` +
      'Provide either a 04t… id or an install URL containing one, via SCV_PACKAGE_VERSION_ID.',
  );
}

/** Idempotency check: is this exact version already in the org? */
async function isAlreadyInstalled(ctx: PhaseContext, versionId: string): Promise<boolean> {
  const org = requireOrg(ctx);
  const result = await query<{ SubscriberPackageVersionId: string }>(
    org.username,
    `SELECT SubscriberPackageVersionId FROM InstalledSubscriberPackage ` +
      `WHERE SubscriberPackageVersionId = '${versionId}'`,
    { useToolingApi: true },
  ).catch(() => undefined);

  return (result?.totalSize ?? 0) > 0;
}

/** Turns the CLI's install errors into something a human can act on. */
function buildInstallDiagnosis(error: unknown, versionId: string, ctx: PhaseContext): string {
  const detail = error instanceof SfCommandError ? error.message : String(error);
  const lines = [`Package installation of ${versionId} failed: ${detail}`, ''];

  const lower = detail.toLowerCase();
  if (lower.includes('installation key') || lower.includes('invalid key')) {
    lines.push('The package version is protected. Set SCV_PACKAGE_INSTALL_KEY to the vendor-supplied key.');
  } else if (lower.includes('dependen')) {
    lines.push(
      'The package declares an unmet dependency. Managed SCV packages commonly depend on Voice being ',
      'enabled BEFORE installation — confirm the enable-voice phase succeeded, then retry.',
    );
  } else if (lower.includes('not found') || lower.includes('no such')) {
    lines.push(
      `Version id ${versionId} is not visible to this org. Confirm the vendor promoted/released the `,
      'version and that it is available to the org edition you created.',
    );
  } else {
    lines.push(
      `Inspect the install in the org:  sf org open --target-org ${ctx.config.scratchOrg.alias} ` +
        '--path lightning/setup/ImportedPackage/home',
    );
  }
  return lines.join('\n');
}
