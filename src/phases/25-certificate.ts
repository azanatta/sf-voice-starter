/**
 * Phase 25 — Create the self-signed certificate used as the contact center's public key.
 *
 * ============================================================================================
 * WHY THIS IS A METADATA PHASE
 * ============================================================================================
 * The telephony provider needs a public key to verify what Salesforce signs. That key comes from a
 * `Certificate` record, whose DeveloperName is written into the contact center's
 * "Certificate Unique Name" (`certDevName`) field.
 *
 * A Certificate metadata deploy with `caSigned=false` creates the key pair inside Salesforce. The
 * deployed `.crt` is the public half only; Salesforce retains the private half, so the resulting
 * certificate can sign telephony requests. The generated deploy source is deliberately ignored by
 * git, preventing a fixed expiry or certificate artifact from becoming project source.
 * ============================================================================================
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query, sf } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

const CERTIFICATE_SOURCE_DIR = join('generated', 'certificate');

export const certificatePhase: Phase = {
  id: 'certificate',
  title: 'Create the self-signed certificate for the contact center',

  enabled: (ctx) => ctx.config.certificate.create,

  async run(ctx: PhaseContext) {
    const { developerName } = ctx.config.certificate;

    if (await certificateExists(ctx)) {
      ctx.log.skip(`Certificate "${developerName}" exists`);
      ctx.facts['Certificate'] = developerName;
      return;
    }

    await createViaMetadata(ctx);

    if (!(await certificateExists(ctx))) {
      throw new Error(
        `The certificate form was submitted but no Certificate named "${developerName}" exists.\n` +
          `The Certificate metadata deployment completed, but Salesforce did not create the record. ` +
            `Re-run with --only=certificate to see the deploy result.`,
      );
    }

    ctx.log.success(`Certificate "${developerName}" created`);
    ctx.facts['Certificate'] = developerName;
  },
};

/**
 * Idempotency check.
 *
 * `Certificate` is a Tooling API object — a normal `sf data query` against it fails, which would be
 * swallowed by the catch and reported as "does not exist", so the Tooling flag matters here.
 */
export async function certificateExists(ctx: PhaseContext): Promise<boolean> {
  const org = requireOrg(ctx);
  const result = await query<{ DeveloperName: string }>(
    org.username,
    `SELECT DeveloperName FROM Certificate WHERE DeveloperName = '${ctx.config.certificate.developerName}'`,
    { useToolingApi: true },
  ).catch(() => undefined);
  return (result?.totalSize ?? 0) > 0;
}

async function createViaMetadata(ctx: PhaseContext): Promise<void> {
  const org = requireOrg(ctx);
  const { label, developerName, keySize, exportablePrivateKey } = ctx.config.certificate;
  const sourceDir = resolve(process.cwd(), CERTIFICATE_SOURCE_DIR);
  const certificateDir = join(sourceDir, 'certs');
  const certificatePath = join(certificateDir, `${developerName}.crt-meta.xml`);

  rmSync(sourceDir, { recursive: true, force: true });
  mkdirSync(certificateDir, { recursive: true });
  writeFileSync(
    certificatePath,
    certificateMetadata({ label, keySize, exportablePrivateKey }),
    'utf8',
  );
  // Salesforce generates the public PEM when caSigned=false, but the source converter still
  // requires the Certificate type's companion file to exist before it sends the deployment.
  writeFileSync(join(certificateDir, `${developerName}.crt`), '', 'utf8');

  ctx.log.step(`Deploying self-signed certificate "${developerName}" (${keySize}-bit)`);
  await sf(
    [
      'project',
      'deploy',
      'start',
      '--target-org',
      org.username,
      '--source-dir',
      CERTIFICATE_SOURCE_DIR,
      '--wait',
      '5',
      '--test-level',
      'NoTestRun',
    ],
    { timeoutMs: 10 * 60_000, onCommand: (command) => ctx.log.command(command) },
  );
}

function certificateMetadata({
  label,
  keySize,
  exportablePrivateKey,
}: {
  label: string;
  keySize: number;
  exportablePrivateKey: boolean;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Certificate xmlns="http://soap.sforce.com/2006/04/metadata">
    <caSigned>false</caSigned>
    <encryptedWithPlatformEncryption>false</encryptedWithPlatformEncryption>
    <expirationDate>${expirationDate()}</expirationDate>
    <keySize>${keySize}</keySize>
    <masterLabel>${escapeXml(label)}</masterLabel>
    <privateKeyExportable>${exportablePrivateKey}</privateKeyExportable>
</Certificate>
`;
}

function expirationDate(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
