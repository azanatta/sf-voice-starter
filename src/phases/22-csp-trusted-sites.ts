/**
 * Phase 22 — CSP Trusted Sites (Setup → Security → Trusted URLs).
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 * Managed packages frequently load scripts, fonts, media or iframes from their own domains. The
 * browser's Content Security Policy blocks anything not listed as a Trusted URL, and the resulting
 * failure looks like a broken package rather than a missing org setting — which makes it an
 * expensive thing to debug and a cheap thing to configure up front.
 *
 * `CspTrustedSite` is ordinary deployable metadata, so no browser is needed.
 *
 * ORDERING: this runs early (before the package is installed) because trusted sites have no
 * dependency on the package — and because having them in place first means the package's components
 * work the first time anyone opens them.
 *
 * MICROPHONE ACCESS: `canAccessMicrophone` does nothing on its own; it additionally requires
 * `enablePermissionsPolicy` in SecuritySettings, which defaults to false. Since a softphone without
 * microphone access is useless, this phase deploys that flag automatically whenever a site asks for
 * microphone or camera. Verified: the minimal SecuritySettings deploy flips it from false to true.
 * ============================================================================================
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

const CSP_DIR = 'app-src/main/default/cspTrustedSites';
const SETTINGS_DIR = 'app-src/main/default/settings';
const TEMPLATE = 'templates/csp/trustedSite.cspTrustedSite-meta.xml';

export const cspTrustedSitesPhase: Phase = {
  id: 'csp-trusted-sites',
  title: 'Deploy CSP trusted sites',

  enabled: (ctx) => ctx.config.csp.sites.length > 0,

  async run(ctx: PhaseContext) {
    const sites = ctx.config.csp.sites.map(parseSite);

    const duplicates = findDuplicateNames(sites.map((site) => site.name));
    if (duplicates.length > 0) {
      throw new Error(
        `Two trusted sites resolve to the same API name: ${duplicates.join(', ')}.\n` +
          `Give them explicit names using the "Name|https://url" form.`,
      );
    }

    renderSites(ctx, sites);
    const needsPermissionsPolicy =
      ctx.config.csp.canAccessMicrophone || ctx.config.csp.canAccessCamera;
    if (needsPermissionsPolicy) renderPermissionsPolicy(ctx);

    await deploy(ctx, needsPermissionsPolicy);

    ctx.log.success(`${sites.length} trusted site(s) deployed`);
    ctx.facts['CSP trusted sites'] = sites.map((site) => site.url).join(', ');
  },
};

interface TrustedSite {
  name: string;
  url: string;
}

/**
 * Accepts either `https://example.com` or `My_Name|https://example.com`.
 *
 * The explicit-name form exists because two different URLs can reduce to the same derived name
 * (`https://a.example.com` and `https://a.example.com:8443` differ only in a character that is not
 * legal in an API name), and because a hand-chosen name is easier to recognise in Setup.
 */
function parseSite(entry: string): TrustedSite {
  const separator = entry.indexOf('|');
  if (separator !== -1) {
    return {
      name: entry.slice(0, separator).trim(),
      url: entry.slice(separator + 1).trim(),
    };
  }
  return { name: deriveName(entry.trim()), url: entry.trim() };
}

/**
 * Turns a URL into a valid metadata API name.
 *
 * API names allow letters, digits and underscores and cannot start with a digit — so the scheme is
 * dropped, every other illegal character becomes an underscore, and a leading digit gets a prefix.
 */
export function deriveName(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  let name = withoutScheme.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (name === '') name = 'TrustedSite';
  if (/^[0-9]/.test(name)) name = `Site_${name}`;
  return name.slice(0, 80);
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

function renderSites(ctx: PhaseContext, sites: TrustedSite[]): void {
  const templatePath = resolve(process.cwd(), TEMPLATE);
  if (!existsSync(templatePath)) throw new Error(`Missing template ${templatePath}`);
  const template = readFileSync(templatePath, 'utf8');

  // Wipe first: a URL removed from the configuration should not linger as a file from a previous run
  // and get redeployed. (Deleting the file does not delete the site already in the org — see the
  // manual step below.)
  const outputDir = resolve(process.cwd(), CSP_DIR);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const csp = ctx.config.csp;
  for (const site of sites) {
    const tokens: Record<string, string> = {
      ENDPOINT_URL: site.url,
      DESCRIPTION: csp.description,
      CONTEXT: csp.context,
      CAN_CAMERA: String(csp.canAccessCamera),
      CAN_MICROPHONE: String(csp.canAccessMicrophone),
      CONNECT_SRC: String(csp.connectSrc),
      FONT_SRC: String(csp.fontSrc),
      FRAME_SRC: String(csp.frameSrc),
      IMG_SRC: String(csp.imgSrc),
      MEDIA_SRC: String(csp.mediaSrc),
      STYLE_SRC: String(csp.styleSrc),
    };

    let content = template;
    for (const [token, value] of Object.entries(tokens)) {
      content = content.replaceAll(`{{${token}}}`, escapeXml(value));
    }

    writeFileSync(resolve(outputDir, `${site.name}.cspTrustedSite-meta.xml`), content, 'utf8');
    ctx.log.step(`${site.name} → ${site.url}`);
  }
}

/** Writes the one SecuritySettings field that makes microphone/camera access take effect. */
function renderPermissionsPolicy(ctx: PhaseContext): void {
  const dir = resolve(process.cwd(), SETTINGS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'Security.settings-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
      `    <enablePermissionsPolicy>true</enablePermissionsPolicy>\n` +
      `</SecuritySettings>\n`,
    'utf8',
  );
  ctx.log.step('enablePermissionsPolicy = true (required for microphone/camera access)');
}

async function deploy(ctx: PhaseContext, includeSettings: boolean): Promise<void> {
  const org = requireOrg(ctx);
  const args = [
    'project',
    'deploy',
    'start',
    '--target-org',
    org.username,
    '--source-dir',
    CSP_DIR,
  ];
  if (includeSettings) args.push('--source-dir', SETTINGS_DIR);
  args.push('--wait', '20', '--test-level', 'NoTestRun');

  try {
    await sf(args, { timeoutMs: 25 * 60_000, onCommand: (c) => ctx.log.command(c) });
  } catch (error) {
    const detail = error instanceof SfCommandError ? error.message : String(error);
    throw new Error(
      `Deploying CSP trusted sites failed: ${detail}\n\n` +
        `Common causes: a malformed URL (it must include the scheme, e.g. https://example.com), or ` +
        `every directive switched off — Salesforce requires at least one of the connect/font/frame/` +
        `img/media/style flags or camera/microphone to be true.`,
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
