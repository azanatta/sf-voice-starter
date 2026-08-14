/**
 * Phase 55 — Render the vendor's contact center XML with this org's real values.
 *
 * ============================================================================================
 * WHY SUBSTITUTE BEFORE IMPORT RATHER THAN EDIT AFTERWARDS
 * ============================================================================================
 * Four contact center fields can only be filled in once org-specific records exist:
 *
 *   certDevName                        "Certificate Unique Name"  ← the certificate's developer name
 *   reqTelephonyIntegrationCertificate "Public Key"               ← the certificate's PEM body
 *   readyStateId                       "Ready State Id"           ← the Online presence status id
 *   notReadyStateId                    "Not Ready State Id"       ← the Busy presence status id
 *
 * NOTE the two certificate fields are DIFFERENT things and both are needed. `certDevName` is just a
 * name; the field the Setup UI labels **"Public Key"** is `reqTelephonyIntegrationCertificate` and
 * holds the PEM itself. An earlier version filled only the first, which left the contact center's
 * Public Key visibly empty while every phase reported success.
 *
 * The vendor ships the XML with placeholders for all of them. The alternative to substituting them
 * here would be to import the contact center and
 * then edit it through Setup, field by field — a much larger and far more fragile piece of browser
 * automation than the single file upload phase 60 already does.
 *
 * Substituting first means the contact center is correct the moment it is created, and phase 60 does
 * not grow at all.
 *
 * The vendor's original file is never modified: the result is written to `generated/`.
 * ============================================================================================
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { query, sf } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

/** Where the rendered copy is written. Phase 60 uploads this, not the vendor's original. */
export const RENDERED_XML_PATH = 'generated/contact-center.rendered.xml';

export const renderContactCenterPhase: Phase = {
  id: 'render-contact-center',
  title: 'Fill the contact center XML with this org\'s certificate and presence status ids',

  enabled: (ctx) => ctx.config.contactCenter.create,

  async run(ctx: PhaseContext) {
    const source = resolve(process.cwd(), ctx.config.contactCenter.definitionFile);
    if (!existsSync(source)) {
      ctx.log.skip('No vendor XML to render');
      return;
    }

    let xml = readFileSync(source, 'utf8');

    xml = await substituteCertificate(ctx, xml);
    xml = await substitutePresenceStatuses(ctx, xml);

    const target = resolve(process.cwd(), RENDERED_XML_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, xml, 'utf8');

    ctx.log.success(`Rendered to ${RENDERED_XML_PATH}`);
    ctx.facts['Contact center XML'] = RENDERED_XML_PATH;
  },
};

/**
 * Fills BOTH certificate-related items. They are different things and it is easy to fill only one:
 *
 *   certDevName                        "Certificate Unique Name"  — the certificate's developer name
 *   reqTelephonyIntegrationCertificate "Telephony Integration Certificate" — the PUBLIC KEY itself,
 *                                                                           as a PEM block
 *
 * An earlier version set only `certDevName`, which left the contact center's public key visibly
 * empty even though everything reported success.
 */
async function substituteCertificate(ctx: PhaseContext, xml: string): Promise<string> {
  if (!ctx.config.certificate.create) return xml;

  const org = requireOrg(ctx);
  const name = ctx.config.certificate.developerName;

  const result = await query<{ DeveloperName: string }>(
    org.username,
    `SELECT DeveloperName FROM Certificate WHERE DeveloperName = '${name}'`,
    { useToolingApi: true },
  ).catch(() => undefined);

  if ((result?.totalSize ?? 0) === 0) {
    ctx.log.warn(`Certificate "${name}" not found — leaving the certificate fields empty`);
    ctx.manualSteps.push(
      `The contact center's "Certificate Unique Name" and "Telephony Integration Certificate" were ` +
        `left empty because certificate "${name}" does not exist. Calls cannot be signed without it. ` +
        `Create it at Setup → Certificate and Key Management, then set both fields.`,
    );
    return xml;
  }

  ctx.log.step(`certDevName = ${name}`);
  let updated = setItemValue(xml, 'certDevName', name);

  const publicKey = await downloadCertificatePem(ctx, name);
  if (publicKey) {
    ctx.log.step(`reqTelephonyIntegrationCertificate = ${publicKey.split('\n')[0]}… (PEM)`);
    updated = setItemValue(updated, 'reqTelephonyIntegrationCertificate', publicKey);
  } else {
    ctx.log.warn('Could not read the certificate body — the public key field is left empty');
    ctx.manualSteps.push(
      `The contact center's "Telephony Integration Certificate" (public key) is empty. Download it ` +
        `from Setup → Certificate and Key Management → ${name} → Download Certificate and paste the ` +
        `PEM into the field.`,
    );
  }
  return updated;
}

/**
 * Gets the certificate's public key as PEM.
 *
 * Retrieving the `Certificate` metadata type yields the `.crt` alongside its `-meta.xml`, and that
 * `.crt` is exactly the PEM block (`-----BEGIN CERTIFICATE-----` …) the contact center wants. This
 * avoids driving the "Download Certificate" button in Setup and the browser download plumbing that
 * would come with it.
 *
 * Salesforce never exports the PRIVATE key this way, which is correct — only the public half is
 * needed here, and it is what the telephony provider verifies signatures against.
 */
async function downloadCertificatePem(
  ctx: PhaseContext,
  developerName: string,
): Promise<string | undefined> {
  const org = requireOrg(ctx);

  // Must be inside the project root — the CLI rejects an output directory outside it.
  const outputDir = join('generated', 'certificate');
  rmSync(resolve(process.cwd(), outputDir), { recursive: true, force: true });

  try {
    await sf(
      [
        'project',
        'retrieve',
        'start',
        '--target-org',
        org.username,
        '--metadata',
        `Certificate:${developerName}`,
        '--output-dir',
        outputDir,
      ],
      { onCommand: (c) => ctx.log.command(c) },
    );
  } catch {
    return undefined;
  }

  const crtPath = resolve(process.cwd(), outputDir, 'certs', `${developerName}.crt`);
  if (!existsSync(crtPath)) return undefined;

  const pem = readFileSync(crtPath, 'utf8').trim();
  return pem.includes('BEGIN CERTIFICATE') ? pem : undefined;
}

async function substitutePresenceStatuses(ctx: PhaseContext, xml: string): Promise<string> {
  if (!ctx.config.presence.create) return xml;

  const org = requireOrg(ctx);
  const { readyStatusLabel, notReadyStatusLabel } = ctx.config.presence;

  const result = await query<{ Id: string; MasterLabel: string }>(
    org.username,
    'SELECT Id, MasterLabel FROM ServicePresenceStatus',
  );

  const byLabel = new Map(result.records.map((record) => [record.MasterLabel, record.Id]));
  const readyId = byLabel.get(readyStatusLabel);
  const notReadyId = byLabel.get(notReadyStatusLabel);

  if (!readyId || !notReadyId) {
    throw new Error(
      `Presence statuses not found in the org: ` +
        `${!readyId ? `"${readyStatusLabel}" ` : ''}${!notReadyId ? `"${notReadyStatusLabel}"` : ''}\n` +
        `Available: ${[...byLabel.keys()].join(', ') || '(none)'}\n` +
        `They are deployed by the deploy-settings phase from ` +
        `force-app/main/default/servicePresenceStatuses/.`,
    );
  }

  ctx.log.step(`readyStateId = ${readyId} (${readyStatusLabel})`);
  ctx.log.step(`notReadyStateId = ${notReadyId} (${notReadyStatusLabel})`);

  return setItemValue(setItemValue(xml, 'readyStateId', readyId), 'notReadyStateId', notReadyId);
}

/**
 * Replaces the body of `<item ... name="<itemName>" ...>VALUE</item>`.
 *
 * Written as a targeted regex rather than a full XML round-trip on purpose: re-serialising the
 * document would reorder attributes and reflow whitespace, producing a file that no longer visibly
 * matches what the vendor shipped. Keeping the diff to the values alone means anyone comparing the
 * rendered copy with the original sees exactly what this project changed and nothing else.
 *
 * Handles both a placeholder body and an empty element, and escapes the replacement so a value
 * containing XML metacharacters cannot corrupt the document.
 */
function setItemValue(xml: string, itemName: string, value: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Matches the opening tag with this name (attributes in any order), then anything up to </item>.
  const pattern = new RegExp(`(<item\\b[^>]*\\bname="${itemName}"[^>]*>)([\\s\\S]*?)(</item>)`);

  if (!pattern.test(xml)) {
    throw new Error(
      `The contact center XML has no <item name="${itemName}"> element to fill in. ` +
        `Either the vendor changed their template or the wrong file is configured.`,
    );
  }
  return xml.replace(pattern, `$1${escaped}$3`);
}
