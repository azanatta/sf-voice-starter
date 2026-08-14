/**
 * Phase 60 — Create the Partner Telephony contact center by importing the vendor's XML.
 *
 * ============================================================================================
 * WHY THIS IS THE ONE PHASE THAT GENUINELY NEEDS A BROWSER
 * ============================================================================================
 * Telephony vendors ship a contact center definition in the **Setup import format**:
 *
 *     <callCenter>
 *       <section sortOrder="0" name="reqGeneralInfo" label="General Information">
 *         <item sortOrder="0" name="reqInternalName" label="InternalName">...</item>
 *
 * That is NOT the Metadata API `CallCenter` format (`<CallCenter xmlns=...>` with `<sections>` /
 * `<items>`). Converting between them was attempted and rejected by the platform — first
 * `Element ... sortOrder invalid at this location in type CallCenterItem`, then
 * `The name "null" is not valid.` The vendor's file is meant to be *imported*, and the import is a
 * file upload in the Setup wizard. There is no API for it.
 *
 * So the flow below drives that upload. Every step here was verified against a live org, and the
 * ordering matters more than it looks:
 *
 *   1. Setup node `ServiceCloudVoicePartnerTelephonyContactCenters`. Note this is NOT `CallCenters`,
 *      which is the legacy CTI page and shows an unrelated "Say Hello to Salesforce Call Center"
 *      splash. The page also only appears once the Partner Telephony permission set is assigned to
 *      the running user — which is why this phase runs after phase 40, not just after phase 50.
 *   2. Click New. The button is disabled until Voice is enabled AND the vendor package is installed.
 *   3. Select the telephony provider FIRST. Uploading before selecting fails with
 *      "The vendor name in the XML file must match the name of the vendor that you selected."
 *   4. Next.
 *   5. Upload the XML on step 2. On success the wizard closes itself — the dialog disappearing IS
 *      the completion signal, which is why the code waits for detachment rather than a Save button.
 * ============================================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gotoSetup } from '../session.js';
import { query } from '../sf.js';
import type { ScvSetupConfig } from '../../config/scv-setup.config.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';
import { contactCenterPage } from '../ui/selectors.js';
import { RENDERED_XML_PATH } from './55-render-contact-center.js';

interface VendorInfo {
  DeveloperName: string;
  MasterLabel?: string;
}

export const contactCenterPhase: Phase = {
  id: 'contact-center',
  title: 'Import the Partner Telephony contact center',
  usesBrowser: true,

  enabled: (ctx) => ctx.config.contactCenter.create,

  async run(ctx: PhaseContext) {
    // Prefer the copy phase 55 rendered with this org's certificate name and presence status ids.
    // Falling back to the vendor's original keeps `--only=contact-center` usable on its own, but the
    // resulting contact center will still carry the vendor's placeholders — so say so rather than
    // importing something half-configured in silence.
    const renderedPath = resolve(process.cwd(), RENDERED_XML_PATH);
    const useRendered = existsSync(renderedPath);

    const xmlPath = useRendered ? RENDERED_XML_PATH : ctx.config.contactCenter.definitionFile.trim();
    const xmlFullPath = useRendered ? renderedPath : resolve(process.cwd(), xmlPath);

    if (!useRendered) {
      ctx.log.warn(
        'Importing the vendor XML unrendered — certificate name and presence status ids will keep ' +
          'their placeholder values. Run the render-contact-center phase first to fill them in.',
      );
    }

    const resolvedName = resolveInternalName(ctx.config);
    if (resolvedName !== ctx.config.contactCenter.internalName) {
      ctx.log.step(`Using internal name "${resolvedName}" from the XML`);
      ctx.config.contactCenter.internalName = resolvedName;
    }

    if (await contactCenterExists(ctx)) {
      ctx.log.skip(`Contact center "${ctx.config.contactCenter.internalName}" exists`);
      ctx.facts['Contact center'] = ctx.config.contactCenter.internalName;
      return;
    }

    if (xmlPath === '' || !existsSync(xmlFullPath)) {
      ctx.log.warn(`No contact center XML at "${xmlPath || '(unset)'}" — skipping`);
      ctx.manualSteps.push(
        `No contact center was created. Point SCV_CC_DEFINITION_FILE at the XML your telephony ` +
          `vendor supplies, then re-run with --only=contact-center. Without a file the contact ` +
          `center must be created by hand in Setup → Contact Centers.`,
      );
      return;
    }

    // No vendor package installed means there is nothing to import against — the wizard's provider
    // list would be empty. That is NOT an error: stopping at "ready to install" is a supported way to
    // use this project, and a run configured that way must not end red. Skip with an explanation.
    if (!(await hasAnyVendorInfo(ctx))) {
      const configuredPackage = ctx.config.package.versionId.trim();
      ctx.log.warn('No telephony vendor is installed in this org — skipping the contact center');
      ctx.manualSteps.push(
        configuredPackage === ''
          ? 'No contact center was imported because no vendor package is installed and no package ' +
            'id is configured. Set the package version id (SCV_PACKAGE_VERSION_ID, or the "Package ' +
            'version id" field in `npm run configure`) and re-run.'
          : `No contact center was imported: package "${configuredPackage}" is configured but the org ` +
            'has no ConversationVendorInfo records, so the install did not provide a telephony ' +
            'vendor. Check the install-package phase output, then re-run with --only=contact-center.',
      );
      return;
    }

    const vendorLabel = await resolveVendorLabel(ctx, xmlFullPath);
    await importViaWizard(ctx, xmlFullPath, vendorLabel);

    // The wizard closing is a strong signal but not proof. Confirm against the data.
    if (!(await contactCenterExists(ctx))) {
      throw new Error(
        `The import wizard completed but no CallCenter with InternalName ` +
          `"${ctx.config.contactCenter.internalName}" exists.\n` +
          `Check that contactCenter.internalName matches the <item name="reqInternalName"> value in ` +
          `${xmlPath}, then re-run with --only=contact-center --headed to watch.`,
      );
    }

    ctx.log.success(`Contact center "${ctx.config.contactCenter.internalName}" imported`);
    ctx.facts['Contact center'] = `${ctx.config.contactCenter.internalName} (imported from XML)`;

    // The certificate name and presence status ids are filled in by phase 55, so they are no longer
    // listed here. What remains genuinely cannot be derived: the provider's own connection details.
    ctx.manualSteps.push(
      `Replace the vendor's placeholder connection values on contact center ` +
        `"${ctx.config.contactCenter.internalName}" with your real ones — telephony endpoints ` +
        `(the XML ships https://pbx-a.example.com), tenant, and any Not Ready reason or presence ` +
        `mapping your provider requires. The certificate and the Ready/Not Ready status ids are ` +
        `already set.`,
    );
  },
};

/**
 * The contact center's internal name: taken from the vendor XML's `reqInternalName` unless
 * explicitly overridden.
 *
 * The XML is the authority because the import uses that value verbatim, and the idempotency check
 * looks the name up afterwards — if the two disagree, every run re-imports and the wizard errors on
 * the duplicate.
 *
 * Exported and pure so the phase and the verification tests resolve the SAME name. An earlier version
 * derived it inside the phase by mutating config, which meant the tests read the stale default and
 * failed against a correctly-configured org.
 */
export function resolveInternalName(config: ScvSetupConfig): string {
  // An explicit environment override always wins — for the odd org where the platform transforms the
  // imported name.
  if (process.env['SCV_CC_INTERNAL_NAME']) return config.contactCenter.internalName;

  // Read from the file that will ACTUALLY be imported. Phase 55 does not currently rewrite
  // reqInternalName, so the rendered copy and the vendor original agree today — but reading the
  // original while importing the rendered copy is a coupling that would break silently the moment
  // phase 55 gained a reason to touch that item. Preferring the rendered file removes the trap.
  const rendered = resolve(process.cwd(), RENDERED_XML_PATH);
  const candidates = [
    existsSync(rendered) ? rendered : undefined,
    config.contactCenter.definitionFile.trim() === ''
      ? undefined
      : resolve(process.cwd(), config.contactCenter.definitionFile.trim()),
  ];

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const fromXml = readItemFromXml(candidate, 'reqInternalName');
    if (fromXml) return fromXml;
  }
  return config.contactCenter.internalName;
}

/** Idempotency check, via the CallCenter object. */
async function contactCenterExists(ctx: PhaseContext): Promise<boolean> {
  const org = requireOrg(ctx);
  const name = ctx.config.contactCenter.internalName;
  const result = await query<{ InternalName: string }>(
    org.username,
    `SELECT InternalName FROM CallCenter WHERE InternalName = '${name}'`,
  ).catch(() => undefined);
  return (result?.totalSize ?? 0) > 0;
}

/** True when the org has at least one telephony vendor to choose from. */
async function hasAnyVendorInfo(ctx: PhaseContext): Promise<boolean> {
  const org = requireOrg(ctx);
  const result = await query<VendorInfo>(
    org.username,
    'SELECT DeveloperName FROM ConversationVendorInfo',
  ).catch(() => undefined);
  return (result?.records.length ?? 0) > 0;
}

/**
 * Works out which telephony provider to pick in the wizard.
 *
 * The wizard lists providers by their `ConversationVendorInfo.MasterLabel` (e.g. "Acme Telephony |
 * Contact Center"), but the XML identifies the vendor by API name in `reqVendorInfoApiName` (e.g.
 * `acme__acmeTelephony`). Reading the XML and mapping it to the installed vendor infos means the
 * caller does not have to configure the label by hand and cannot pick a mismatched pair — which the
 * wizard rejects outright.
 *
 * The namespace prefix is stripped because the record's DeveloperName has no namespace.
 */
async function resolveVendorLabel(ctx: PhaseContext, xmlPath: string): Promise<string> {
  const org = requireOrg(ctx);
  const configured = ctx.config.contactCenter.vendorInfoDeveloperName.trim();

  const result = await query<VendorInfo>(
    org.username,
    'SELECT DeveloperName, MasterLabel FROM ConversationVendorInfo',
  ).catch(() => undefined);
  const vendors = result?.records ?? [];

  if (vendors.length === 0) {
    throw new Error(
      'No ConversationVendorInfo records exist in the org, so no telephony provider can be chosen.\n' +
        'Install the vendor package first (set SCV_PACKAGE_VERSION_ID).',
    );
  }

  const wanted = configured !== '' ? configured : readItemFromXml(xmlPath, 'reqVendorInfoApiName');
  if (!wanted) {
    throw new Error(
      `Could not determine the telephony vendor: ${xmlPath} has no <item name="reqVendorInfoApiName"> ` +
        `value and SCV_VENDOR_INFO is not set.\n` +
        `Installed vendors: ${vendors.map((v) => v.DeveloperName).join(', ')}`,
    );
  }

  // `acme__acmeTelephony` -> `acmeTelephony`
  const bare = wanted.includes('__') ? wanted.slice(wanted.lastIndexOf('__') + 2) : wanted;
  const match = vendors.find((vendor) => vendor.DeveloperName === bare);

  if (!match) {
    throw new Error(
      `The XML asks for vendor "${wanted}" but the org has no matching ConversationVendorInfo.\n` +
        `Installed: ${vendors.map((v) => v.DeveloperName).join(', ')}\n` +
        `Either the wrong package is installed, or the XML is for a different vendor.`,
    );
  }

  const label = match.MasterLabel ?? match.DeveloperName;
  ctx.log.step(`Vendor "${label}" (from ${wanted})`);
  return label;
}

/**
 * Reads a single `<item name="...">value</item>` out of the vendor's import-format XML.
 *
 * A regex rather than an XML parser on purpose: this reads two well-known scalar items from a small
 * file that the platform itself is about to validate. Adding a parser dependency to extract two
 * strings would be the more fragile choice, not the less.
 */
function readItemFromXml(xmlPath: string, itemName: string): string | undefined {
  const xml = readFileSync(xmlPath, 'utf8');
  const match = xml.match(new RegExp(`name="${itemName}"[^>]*>([^<]+)<`));
  return match?.[1]?.trim();
}

/** Drives the verified New → select vendor → Next → upload flow. */
async function importViaWizard(ctx: PhaseContext, xmlPath: string, vendorLabel: string): Promise<void> {
  const page = await ctx.ui();
  await gotoSetup(page, contactCenterPage.setupNode, ctx.log);

  ctx.log.step('Opening the New Partner Contact Center wizard');
  await contactCenterPage.newButton(page).click();

  const dialog = contactCenterPage.dialog(page);
  await dialog.waitFor({ state: 'visible', timeout: ctx.config.runtime.navigationTimeoutMs });

  // Vendor MUST be selected before the upload, or the wizard rejects the file.
  ctx.log.step(`Selecting telephony provider "${vendorLabel}"`);
  await contactCenterPage.vendorOption(dialog, vendorLabel).click();
  await contactCenterPage.nextButton(dialog).click();

  ctx.log.step(`Uploading ${xmlPath}`);
  await contactCenterPage.fileInput(dialog).setInputFiles(xmlPath);

  // The wizard closes itself on a successful import — that is the completion signal.
  await dialog.waitFor({ state: 'detached', timeout: ctx.config.runtime.navigationTimeoutMs });
  ctx.log.success('Import wizard completed');
}
