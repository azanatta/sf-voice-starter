/**
 * Phase 24 — Remote Site Settings (Setup → Security → Remote Site Settings).
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 * Remote Site Settings are the SERVER side allow list. Anything the org itself calls out to — Apex
 * callouts, the Voice runtime's own endpoints, a vendor's REST API — is refused unless its host is
 * listed here, with an error that names the URL but not the setting that blocked it.
 *
 * That is a different node from Trusted URLs / CSP trusted sites (phase 22), which is the BROWSER
 * side allow list. A telephony package normally needs entries in both, and the two lists are
 * configured separately because they rarely hold the same hosts.
 *
 * ============================================================================================
 * THE SCRT2 ENTRY, WHICH IS THE POINT OF AUTOMATING THIS
 * ============================================================================================
 * Service Cloud Voice carries calls over SCRT2, reachable at the org's own My Domain with
 * `.my.salesforce.com` swapped for `.my.salesforce-scrt.com`. Every org — and so every scratch org
 * this project creates — has a different one, which makes it the one entry that cannot be written
 * into configuration ahead of time and the one that is most often forgotten.
 *
 * So it is derived from the org's instance URL and added automatically, on a fresh org and on an
 * existing one (`--org=<alias>`) alike. `SCV_REMOTE_SITE_ADD_SCRT=false` turns that off.
 *
 * ORDERING: after create-org (it needs the instance URL) and alongside the other metadata phases,
 * well before the package is installed, so the endpoints are reachable the first time anything uses
 * them.
 * ============================================================================================
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';
import { deriveApiName, sameUrl, scrtUrlFor } from '../urls.js';

const OUTPUT_DIR = 'app-src/main/default/remoteSiteSettings';
const TEMPLATE = 'templates/remote-site/remoteSite.remoteSite-meta.xml';

/**
 * API name of the derived SCRT2 entry.
 *
 * Deliberately a STABLE name rather than one derived from the host: re-running against the same org
 * then updates the one entry instead of leaving a second copy behind, and a reader in Setup can see
 * at a glance which entry the script owns.
 */
const SCRT_SITE_NAME = 'Salesforce_SCRT2';

/**
 * Maximum length of a RemoteSiteSetting API name.
 *
 * VERIFIED the hard way: a name derived from a scratch org's SCRT2 host (51 characters) fails the
 * deploy with "Value too long for field: fullName maximum length is:40". Note this is HALF the 80
 * that CspTrustedSite allows, so the two phases cannot share a limit.
 */
const NAME_MAX_LENGTH = 40;

export const remoteSiteSettingsPhase: Phase = {
  id: 'remote-sites',
  title: 'Deploy remote site settings',

  // Note the difference from phase 22: this phase is worth running with an EMPTY configured list,
  // because the derived SCRT2 entry alone justifies it.
  enabled: (ctx) =>
    ctx.config.remoteSites.sites.length > 0 || ctx.config.remoteSites.addScrtSite,

  async run(ctx: PhaseContext) {
    const org = requireOrg(ctx);
    const sites = ctx.config.remoteSites.sites.map(parseSite);

    if (ctx.config.remoteSites.addScrtSite) {
      const scrtUrl = scrtUrlFor(org.instanceUrl);
      if (!scrtUrl) {
        ctx.log.warn(
          `Could not derive an SCRT2 endpoint from "${org.instanceUrl}" — it is not a ` +
            `*.my.salesforce.com URL. Add the org's SCRT2 remote site by hand if Voice needs it.`,
        );
      } else {
        // A hand-configured entry for the same URL is dropped in favour of this one: Salesforce
        // rejects two remote sites carrying the same URL, so deploying both fails — and keeping the
        // canonical name means a re-run updates the existing entry instead of colliding with it.
        const duplicate = sites.findIndex((site) => sameUrl(site.url, scrtUrl));
        if (duplicate !== -1) {
          ctx.log.step(
            `SCRT2 endpoint is in the configured list too; keeping the automatic ${SCRT_SITE_NAME} entry`,
          );
          sites.splice(duplicate, 1);
        }
        sites.push({ name: SCRT_SITE_NAME, url: scrtUrl, derived: true });
        ctx.log.step(`Derived SCRT2 endpoint from the org URL: ${scrtUrl}`);
        ctx.facts['SCRT2 remote site'] = scrtUrl;
      }
    }

    if (sites.length === 0) {
      ctx.log.skip('No remote sites to deploy');
      return;
    }

    const tooLong = sites.filter((site) => site.name.length > NAME_MAX_LENGTH);
    if (tooLong.length > 0) {
      throw new Error(
        `These remote site names are longer than ${NAME_MAX_LENGTH} characters, which the platform ` +
          `rejects: ${tooLong.map((site) => site.name).join(', ')}.\n` +
          `Choose a shorter name using the "Name|https://url" form.`,
      );
    }

    const duplicates = findDuplicateNames(sites.map((site) => site.name));
    if (duplicates.length > 0) {
      throw new Error(
        `Two remote sites resolve to the same API name: ${duplicates.join(', ')}.\n` +
          `Give them explicit names using the "Name|https://url" form.`,
      );
    }

    renderSites(ctx, sites);
    await deploy(ctx, org.username);

    ctx.log.success(`${sites.length} remote site(s) deployed`);
    ctx.facts['Remote site settings'] = sites.map((site) => site.url).join(', ');
  },
};

interface RemoteSite {
  name: string;
  url: string;
  /** True for the SCRT2 entry this phase computes, so logs can distinguish it from configured ones. */
  derived?: boolean;
}

/** Accepts either `https://example.com` or `My_Name|https://example.com`, as phase 22 does. */
function parseSite(entry: string): RemoteSite {
  const separator = entry.indexOf('|');
  if (separator !== -1) {
    return {
      name: entry.slice(0, separator).trim(),
      url: entry.slice(separator + 1).trim(),
    };
  }
  return { name: deriveApiName(entry.trim(), NAME_MAX_LENGTH), url: entry.trim() };
}

function findDuplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

function renderSites(ctx: PhaseContext, sites: RemoteSite[]): void {
  const templatePath = resolve(process.cwd(), TEMPLATE);
  if (!existsSync(templatePath)) throw new Error(`Missing template ${templatePath}`);
  const template = readFileSync(templatePath, 'utf8');

  // Wipe first, for the same reason as phase 22: a URL removed from the configuration should not
  // linger as a file from a previous run and get redeployed. (Deleting the file does not delete the
  // remote site already in the org — that stays until someone removes it in Setup.)
  const outputDir = resolve(process.cwd(), OUTPUT_DIR);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  for (const site of sites) {
    const content = template
      .replaceAll('{{URL}}', escapeXml(site.url))
      .replaceAll('{{DESCRIPTION}}', escapeXml(ctx.config.remoteSites.description));

    writeFileSync(resolve(outputDir, `${site.name}.remoteSite-meta.xml`), content, 'utf8');
    if (!site.derived) ctx.log.step(`${site.name} → ${site.url}`);
  }
}

async function deploy(ctx: PhaseContext, username: string): Promise<void> {
  try {
    await sf(
      [
        'project',
        'deploy',
        'start',
        '--target-org',
        username,
        '--source-dir',
        OUTPUT_DIR,
        '--wait',
        '20',
        '--test-level',
        'NoTestRun',
      ],
      { timeoutMs: 25 * 60_000, onCommand: (c) => ctx.log.command(c) },
    );
  } catch (error) {
    // The CLI's own message for a component-level rejection is just "sf command failed", so dig the
    // per-component problems out of the payload. They are the only part worth reading: "Value too
    // long for field: fullName" and "duplicate value found" both arrive this way.
    const detail = error instanceof SfCommandError ? error.message : String(error);
    const problems = componentProblems(error);
    throw new Error(
      `Deploying remote site settings failed: ${detail}` +
        (problems.length > 0 ? `\n\n${problems.join('\n')}` : '') +
        `\n\nCommon causes: a malformed URL (it must include the scheme, e.g. https://example.com), ` +
        `a name longer than ${NAME_MAX_LENGTH} characters, or another remote site in the org that ` +
        `already carries the same URL under a different name.`,
    );
  }
}

interface DeployFailure {
  fullName?: string;
  componentType?: string;
  problem?: string;
}

/** Pulls per-component problems out of a failed deploy, whichever shape the CLI returned them in. */
function componentProblems(error: unknown): string[] {
  if (!(error instanceof SfCommandError)) return [];
  const payload = error.payload as
    | {
        data?: { details?: { componentFailures?: DeployFailure[] } };
        result?: { details?: { componentFailures?: DeployFailure[] } };
      }
    | undefined;
  const failures =
    payload?.data?.details?.componentFailures ?? payload?.result?.details?.componentFailures ?? [];
  return failures.map(
    (failure) =>
      `${failure.componentType ?? 'Component'} ${failure.fullName ?? ''}: ${failure.problem ?? 'unknown problem'}`,
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
