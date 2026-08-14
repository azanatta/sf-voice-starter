/**
 * Phase 25 — Create the self-signed certificate used as the contact center's public key.
 *
 * ============================================================================================
 * WHY THIS IS A BROWSER PHASE
 * ============================================================================================
 * The telephony provider needs a public key to verify what Salesforce signs. That key comes from a
 * `Certificate` record, whose DeveloperName is written into the contact center's
 * "Certificate Unique Name" (`certDevName`) field.
 *
 * Three things were established before choosing this route:
 *
 *   1. The vendor's managed package ships NO certificate — `SELECT ... FROM Certificate` returns
 *      zero rows in a fresh org with the package installed.
 *   2. Deploying the `Certificate` metadata type with only its `-meta.xml` does not work. The CLI
 *      refuses before contacting the org: `Expected source files for type 'Certificate'`. A `.crt`
 *      content file must accompany it.
 *   3. A `.crt` deployed from a repo carries no private key into the target org, and would also mean
 *      committing an artifact with a fixed expiry that silently starts producing broken orgs.
 *
 * Generating the certificate in the org avoids all three: the key pair is created server-side, so
 * the certificate can actually sign, and nothing expiring lives in source control. Salesforce
 * deliberately offers no API for this — a private key that could be uploaded would not be a secret —
 * which makes this a genuine UI-only step rather than a convenience.
 *
 * The form is a classic Visualforce page inside the Lightning shell; see `certificatePage` in
 * src/ui/selectors.ts for the frame handling.
 * ============================================================================================
 */

import { gotoSetup } from '../session.js';
import { query } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';
import { certificatePage } from '../ui/selectors.js';

export const certificatePhase: Phase = {
  id: 'certificate',
  title: 'Create the self-signed certificate for the contact center',
  usesBrowser: true,

  enabled: (ctx) => ctx.config.certificate.create,

  async run(ctx: PhaseContext) {
    const { developerName } = ctx.config.certificate;

    if (await certificateExists(ctx)) {
      ctx.log.skip(`Certificate "${developerName}" exists`);
      ctx.facts['Certificate'] = developerName;
      return;
    }

    await createViaUi(ctx);

    if (!(await certificateExists(ctx))) {
      throw new Error(
        `The certificate form was submitted but no Certificate named "${developerName}" exists.\n` +
          `Re-run with --only=certificate --headed to watch, or create it by hand at ` +
          `Setup → Certificate and Key Management → Create Self-Signed Certificate.`,
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

async function createViaUi(ctx: PhaseContext): Promise<void> {
  const page = await ctx.ui();
  const { label, developerName, keySize, exportablePrivateKey } = ctx.config.certificate;

  await gotoSetup(page, certificatePage.setupNode, ctx.log);

  const listFrame = await certificatePage.frameWithCreateButton(page);
  if (!listFrame) {
    throw new Error(
      'Could not find the "Create Self-Signed Certificate" button on ' +
        `Setup → ${certificatePage.setupNode}. The page is a Visualforce frame inside the Lightning ` +
        'shell; if Salesforce has converted it to Lightning, the frame lookup in ' +
        'src/ui/selectors.ts needs updating.',
    );
  }

  ctx.log.step('Opening the self-signed certificate form');
  await certificatePage.createSelfSignedButton(listFrame).click();

  // The form replaces the list inside the same frame, but re-resolving is safer than assuming the
  // frame object survives the navigation.
  await page.waitForTimeout(2_000);
  const formFrame = await waitForFormFrame(ctx);

  const labelField = certificatePage.form.label(formFrame);
  const nameField = certificatePage.form.developerName(formFrame);

  await labelField.fill(label);

  // Salesforce auto-derives Unique Name from Label in JavaScript, and that handler runs when Label
  // loses focus — i.e. AFTER a naive `fill(label); fill(developerName)` sequence. The observed result
  // was a certificate whose Unique Name was the value DOUBLED ("Certificate_SFCertificate_SF"), which
  // then silently fails the contact center's certDevName reference.
  //
  // So: blur Label first, let the handler do whatever it wants, then clear and set the name, and
  // assert the field actually holds what we asked for before saving.
  await labelField.evaluate((element: HTMLInputElement) => element.blur());
  await formFrame.page().waitForTimeout(500);

  await nameField.fill('');
  await nameField.fill(developerName);
  await nameField.evaluate((element: HTMLInputElement) => element.blur());
  await formFrame.page().waitForTimeout(500);

  const actualName = await nameField.inputValue();
  if (actualName !== developerName) {
    throw new Error(
      `The Unique Name field holds "${actualName}" but should hold "${developerName}". ` +
        `Salesforce's auto-derive handler has changed behaviour; fix the sequence in ` +
        `src/phases/25-certificate.ts.`,
    );
  }

  await certificatePage.form.keySize(formFrame).selectOption(String(keySize));

  const exportable = certificatePage.form.exportable(formFrame);
  if ((await exportable.isChecked()) !== exportablePrivateKey) {
    await exportable.setChecked(exportablePrivateKey);
  }

  ctx.log.step(`Saving certificate "${developerName}" (${keySize}-bit)`);
  await certificatePage.form.save(formFrame).click();

  // Key generation is not instant; the verification query below tolerates the lag.
  await page.waitForTimeout(5_000);
}

/** Waits for the form frame to appear, since it arrives asynchronously after the button click. */
async function waitForFormFrame(ctx: PhaseContext) {
  const page = await ctx.ui();
  const deadline = Date.now() + ctx.config.runtime.navigationTimeoutMs;
  while (Date.now() < deadline) {
    const frame = await certificatePage.frameWithForm(page);
    if (frame) return frame;
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    'The self-signed certificate form never appeared after clicking the create button.',
  );
}
