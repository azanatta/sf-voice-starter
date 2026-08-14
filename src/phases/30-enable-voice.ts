/**
 * Phase 30 — Ensure Service Cloud Voice with Partner Telephony is actually enabled.
 *
 * ============================================================================================
 * HOW VOICE GETS ENABLED, AND WHY THE BROWSER IS ONLY A FALLBACK
 * ============================================================================================
 * Enabling Voice is deploying `ServiceCloudVoiceSettings.enableSCVExternalTelephony = true`.
 * That is phase 20's job, and it genuinely works — VERIFIED on a fresh scratch org: the flag read
 * `false`, `sf project deploy start` reported success, and a subsequent retrieve read `true`, with
 * no browser involved. The equivalent UI action is the "Turn on Voice with Partner Telephony"
 * toggle under step 2 of Setup → Salesforce Voice.
 *
 * So this phase does NOT enable Voice in the normal case. It verifies, and repairs only if needed.
 *
 * A TRAP WORTH KNOWING (it cost real debugging time):
 * The three Voice permission sets — ContactCenter{Admin,Agent,Supervisor}ExternalTelephony — and the
 * `ServiceCloudVoiceExternalTelephonyPsl` permission set license are created by the scratch org
 * FEATURES, not by enablement. They are present in an org where the toggle is still off. They are
 * therefore useless as an enablement probe, even though they look like a perfect one. The only
 * trustworthy signal is the settings flag itself, which is what is read below.
 * ============================================================================================
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gotoSetup } from '../session.js';
import { sf } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';
import { voiceSettingsPage } from '../ui/selectors.js';

/**
 * How long to keep re-checking after flipping the toggle in the UI.
 * The setting is not always readable back instantly, so poll rather than sleep a fixed amount.
 */
const VERIFY_TIMEOUT_MS = 2 * 60_000;
const VERIFY_INTERVAL_MS = 10_000;

export const enableVoicePhase: Phase = {
  id: 'enable-voice',
  title: 'Ensure Service Cloud Voice with Partner Telephony is enabled',
  // "can open a browser", not "does". The normal path is a metadata read and never launches one —
  // `ctx.ui()` is lazy. The flag is true so that a failure here suggests `--headed`, which is exactly
  // the run you want when the fallback toggle is misbehaving.
  usesBrowser: true,

  async run(ctx: PhaseContext) {
    if (await isVoiceEnabled(ctx)) {
      ctx.log.skip('Voice with Partner Telephony is enabled (enableSCVExternalTelephony = true)');
      ctx.facts['Voice enablement'] = 'enabled via metadata';
      return;
    }

    // The deploy in phase 20 should have handled this. Reaching here means it did not take effect,
    // so fall back to the UI toggle — the one action a human would take.
    ctx.log.warn('enableSCVExternalTelephony is false even after the settings deploy');
    ctx.log.step('Falling back to the Setup toggle');
    await enableViaUi(ctx);

    if (!(await waitForVoiceEnabled(ctx))) {
      throw new Error(
        'Voice is still not enabled after both the metadata deploy and the Setup toggle.\n' +
          'Inspect the org directly:\n' +
          `  sf org open --target-org ${ctx.config.scratchOrg.alias} ` +
          `--path lightning/setup/${voiceSettingsPage.setupNode}/home\n` +
          'If the page does not render at all, the org is missing the ServiceCloudVoicePartnerTelephony, ' +
          'Scrt2Conversation or BYOOTT scratch org features — see config/project-scratch-def.json.',
      );
    }

    ctx.log.success('Voice with Partner Telephony enabled');
    ctx.facts['Voice enablement'] = 'enabled via Setup UI (metadata deploy did not take)';
  },
};

/**
 * The authoritative readiness probe: read `enableSCVExternalTelephony` back from the org.
 *
 * Retrieves into a temporary directory via `--output-dir` so the tracked, heavily-commented
 * `force-app/main/default/settings/ServiceCloudVoice.settings-meta.xml` is never overwritten by
 * whatever the org currently holds.
 *
 * Exported so the verify phase and the tests use the identical check.
 */
export async function isVoiceEnabled(ctx: PhaseContext): Promise<boolean> {
  const org = requireOrg(ctx);

  // `--output-dir` must be INSIDE the sfdx project root — the CLI rejects an absolute path under
  // the system temp directory outright. So the scratch space lives under `generated/`, which is
  // gitignored. A fresh subdirectory per call avoids reading a stale file from an earlier poll.
  const probeRoot = resolve(process.cwd(), 'generated', 'settings-probe');
  mkdirSync(probeRoot, { recursive: true });
  const outputDir = mkdtempSync(join(probeRoot, 'run-'));

  await sf(
    [
      'project',
      'retrieve',
      'start',
      '--target-org',
      org.username,
      '--metadata',
      'Settings:ServiceCloudVoice',
      // Relative, for the same "must be inside the project" reason.
      '--output-dir',
      relative(process.cwd(), outputDir),
    ],
    { onCommand: (c) => ctx.log.command(c) },
  );

  // The retrieved layout differs between `--output-dir` (which yields `<dir>/settings/…`) and a
  // normal project retrieve (`<dir>/main/default/settings/…`), and has changed across CLI versions.
  // Searching for the file is cheaper to maintain than tracking which shape this CLI produces.
  const settingsFile = findFile(outputDir, 'ServiceCloudVoice.settings-meta.xml');
  if (!settingsFile) {
    throw new Error(
      `Retrieved Settings:ServiceCloudVoice but found no ServiceCloudVoice.settings-meta.xml under ` +
        `${outputDir}. The org may not support the setting, which usually means it is missing the ` +
        `Voice scratch org features.`,
    );
  }

  const xml = readFileSync(settingsFile, 'utf8');
  return /<enableSCVExternalTelephony>\s*true\s*<\/enableSCVExternalTelephony>/.test(xml);
}

/** Depth-first search for a file by name. Returns the first match, or undefined. */
function findFile(directory: string, fileName: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return undefined;
}

async function waitForVoiceEnabled(ctx: PhaseContext): Promise<boolean> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isVoiceEnabled(ctx)) return true;
    ctx.log.step('Waiting for the setting to reflect the change…');
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  return false;
}

/** Flips the "Turn on Voice with Partner Telephony" toggle in Setup → Salesforce Voice. */
async function enableViaUi(ctx: PhaseContext): Promise<void> {
  const page = await ctx.ui();
  await gotoSetup(page, voiceSettingsPage.setupNode, ctx.log);

  const toggle = voiceSettingsPage.partnerTelephonyToggle(page);

  // The setup assistant is a slow Lightning page; give it time to draw before touching anything.
  await toggle.waitFor({ state: 'attached', timeout: ctx.config.runtime.navigationTimeoutMs });

  if (await voiceSettingsPage.isToggleOn(toggle)) {
    ctx.log.skip('The Setup toggle is already on');
    return;
  }

  await voiceSettingsPage.clickToggle(page, toggle);
  await voiceSettingsPage.acceptTermsIfPresent(page, ctx.log);
  ctx.log.success('Toggle switched on');
}
