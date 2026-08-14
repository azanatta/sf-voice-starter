/**
 * Every selector in this project lives here.
 *
 * ============================================================================================
 * MAINTENANCE CONTRACT
 * ============================================================================================
 * Salesforce Setup is a first-party app that Salesforce redesigns on its own schedule. Selectors
 * WILL break. The goal of this file is that when they do, the fix is obvious and local:
 *
 *   - No selector strings anywhere else in `src/`. Phases call the helpers exported here.
 *   - Prefer role- and label-based locators over CSS. `getByRole('switch', { name: /…/ })` survives
 *     a restyle; `.slds-form-element__control > input:nth-child(2)` does not.
 *   - Every locator lists FALLBACKS, chained with `.or()`. Salesforce ships the same control as a
 *     lightning-input, a lightning-toggle or a plain checkbox depending on the page's vintage, and
 *     the label text differs between releases ("Service Cloud Voice" vs "Salesforce Voice" — the
 *     product was renamed).
 *   - Anything that can fail benignly is written as "if present", not as a hard wait.
 *
 * To debug a broken selector, run headed and slowed down:
 *   SCV_HEADED=true SCV_SLOWMO_MS=250 npm run setup
 * ============================================================================================
 */

import type { Frame, Locator, Page } from '@playwright/test';
import type { Logger } from '../logger.js';

/* -------------------------------------------------------------------------------------------------
 * Setup → Voice Settings
 * ---------------------------------------------------------------------------------------------- */

export const voiceSettingsPage = {
  /**
   * Setup node id, used to build `/lightning/setup/<node>/home`.
   *
   * VERIFIED: `ServiceCloudVoicePartnerTelephony` is the node for the "Salesforce Voice" setup
   * assistant. It is NOT `VoiceSettings` — that node does not exist, and Lightning's response to an
   * unknown Setup node is not a 404 but a page that hangs on the loading spinner and shows a
   * "Sorry to interrupt / CSS Error" banner. That failure looks exactly like a broken browser or a
   * bad selector, so if this page ever stops rendering, suspect the node name first.
   *
   * The page only renders at all if the org has the ServiceCloudVoicePartnerTelephony,
   * Scrt2Conversation and BYOOTT scratch org features — see config/project-scratch-def.json.
   */
  setupNode: 'ServiceCloudVoicePartnerTelephony',

  /**
   * The "Turn on Voice with Partner Telephony" toggle, under step 2 of the setup assistant.
   *
   * VERIFIED against the rendered page: it is an `input[type=checkbox]` carrying
   * `name="toggle-scv"`. That name attribute is the anchor because:
   *   - the element's `id` is generated per render (`checkbox-toggle-126`) and cannot be relied on;
   *   - it exposes NO accessible name, so `getByRole('switch', { name: … })` matches nothing —
   *     the page has five identical-looking unlabelled switches and only the `name` distinguishes
   *     them (the other four are `toggleMEU` and three × `toggleOrgPref`).
   *
   * The role- and text-based fallbacks below are kept for the day Salesforce adds a proper
   * accessible name, at which point they start working and the brittle attribute stops mattering.
   */
  partnerTelephonyToggle(page: Page): Locator {
    const byName = page.locator('input[name="toggle-scv"]');
    const byRole = page.getByRole('switch', {
      name: /turn on voice with partner telephony|partner telephony|third[- ]party telephony/i,
    });
    const byRowText = page
      .locator('.slds-form-element, li, div')
      .filter({ hasText: /^Turn on Voice with Partner Telephony/i })
      .locator('input[type="checkbox"]')
      .first();

    return byName.or(byRole).or(byRowText).first();
  },

  /**
   * Clicks the toggle.
   *
   * A plain `.click()` on the input FAILS here: SLDS renders a `<span class="slds-form-element__label">`
   * over the checkbox, and Playwright correctly refuses, reporting that the span "intercepts pointer
   * events" — it retries for the full timeout and then throws. Clicking the associated `<label>` is
   * the interaction a real user performs and is what actually works.
   */
  async clickToggle(page: Page, toggle: Locator): Promise<void> {
    const id = await toggle.getAttribute('id');
    if (id) {
      const label = page.locator(`label[for="${id}"]`);
      if ((await label.count()) > 0) {
        await label.first().click();
        return;
      }
    }
    // No associated label found — dispatch the click directly on the input, bypassing the overlay.
    await toggle.dispatchEvent('click');
  },

  /**
   * Reads a toggle's state across the three ways Salesforce renders one.
   *
   * `isChecked()` throws on elements that are not checkbox-like, so it is guarded and falls back to
   * the aria attribute that lightning-toggle sets.
   */
  async isToggleOn(toggle: Locator): Promise<boolean> {
    if ((await toggle.count()) === 0) return false;
    try {
      return await toggle.isChecked();
    } catch {
      const ariaChecked = await toggle.getAttribute('aria-checked');
      return ariaChecked === 'true';
    }
  },

  /**
   * Accepts a terms-of-service dialog, if one appears when Voice is switched on.
   *
   * UNOBSERVED PATH: flipping the toggle on a Developer-edition scratch org produced NO dialog
   * (verified — the page reported zero dialogs after the click). This is kept because other editions
   * and future releases may gate enablement behind a consent step, and because it costs nothing when
   * absent. Treat the selectors here as unverified guesses, unlike the toggle above.
   *
   * Written as "if present" precisely so the common no-dialog case is not a timeout.
   */
  async acceptTermsIfPresent(page: Page, log: Logger): Promise<void> {
    const dialog = page.getByRole('dialog').filter({
      hasText: /terms|agreement|agree|consent/i,
    });

    // Short timeout: we are testing for presence, not waiting for something we expect.
    const appeared = await dialog
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      log.step('No terms dialog appeared (expected on re-runs)');
      return;
    }

    // Some releases gate the confirm button behind an "I agree" checkbox.
    const agreeCheckbox = dialog.getByRole('checkbox').first();
    if ((await agreeCheckbox.count()) > 0 && !(await agreeCheckbox.isChecked().catch(() => true))) {
      await agreeCheckbox.check();
    }

    const confirm = dialog.getByRole('button', { name: /^(agree|accept|confirm|enable|ok|save)$/i });
    await confirm.first().click();
    log.success('Accepted the Voice terms of service');
  },
};

/* -------------------------------------------------------------------------------------------------
 * Setup → Certificate and Key Management
 * ---------------------------------------------------------------------------------------------- */

export const certificatePage = {
  setupNode: 'CertificatesAndKeysManagement',

  /**
   * This is a CLASSIC Visualforce page embedded in the Lightning shell, so its controls live in an
   * iframe and are invisible to locators resolved against the Page. Worse, several frames are
   * present and only one holds the form — the outer Lightning frame also contains inputs (the global
   * search box), so "the frame with inputs" is not a safe test.
   *
   * Both helpers below therefore locate the frame by a control that is unique to it.
   */
  async frameWithCreateButton(page: Page): Promise<Frame | undefined> {
    for (const frame of page.frames()) {
      const count = await frame
        .locator('input[value="Create Self-Signed Certificate"]')
        .count()
        .catch(() => 0);
      if (count > 0) return frame;
    }
    return undefined;
  },

  /** The form frame, identified by the MasterLabel field that only it contains. */
  async frameWithForm(page: Page): Promise<Frame | undefined> {
    for (const frame of page.frames()) {
      const count = await frame.locator('input#MasterLabel').count().catch(() => 0);
      if (count > 0) return frame;
    }
    return undefined;
  },

  createSelfSignedButton(frame: Frame): Locator {
    return frame.locator('input[value="Create Self-Signed Certificate"]');
  },

  /**
   * Field ids on the self-signed certificate form, VERIFIED by inspecting the rendered page:
   *   input#MasterLabel     Label
   *   input#DeveloperName   Unique Name
   *   select#keysize        Key Size
   *   input#exp             Exportable Private Key
   *   input[name=save]      Save
   *
   * These are classic Visualforce ids, which are stable in a way Lightning's generated ids are not.
   */
  form: {
    label: (frame: Frame): Locator => frame.locator('input#MasterLabel'),
    developerName: (frame: Frame): Locator => frame.locator('input#DeveloperName'),
    keySize: (frame: Frame): Locator => frame.locator('select#keysize'),
    exportable: (frame: Frame): Locator => frame.locator('input#exp'),
    save: (frame: Frame): Locator => frame.locator('input[name="save"]'),
  },
};

/* -------------------------------------------------------------------------------------------------
 * Setup → Contact Centers
 * ---------------------------------------------------------------------------------------------- */

export const contactCenterPage = {
  /**
   * VERIFIED Setup node for Partner Telephony contact centers.
   *
   * NOT `CallCenters` — that is the legacy CTI page and renders an unrelated "Say Hello to Salesforce
   * Call Center" splash with a Continue button.
   *
   * This page only appears once the Partner Telephony permission set is assigned to the running
   * user, which is why phase 60 depends on phase 40 having run.
   */
  setupNode: 'ServiceCloudVoicePartnerTelephonyContactCenters',

  /**
   * The button that opens the wizard.
   *
   * It is DISABLED until Voice is enabled and the vendor's managed package is installed. If a run
   * hangs here, check those two things before suspecting the selector.
   */
  newButton(page: Page): Locator {
    return page.getByRole('button', { name: /^New$/ }).first();
  },

  /** The wizard modal. Its disappearance is how a successful import is detected. */
  dialog(page: Page): Locator {
    return page.getByRole('dialog').first();
  },

  /**
   * A telephony provider radio option.
   *
   * Matched by visible text, not by role name: like the Voice toggle, these radios expose no
   * accessible name (all three returned an empty aria-label), so `getByRole('radio', { name })`
   * matches nothing. The visible label is the `ConversationVendorInfo.MasterLabel`, e.g.
   * "Acme Telephony | Contact Center".
   *
   * The provider MUST be selected before the XML upload — otherwise the wizard rejects the file with
   * "The vendor name in the XML file must match the name of the vendor that you selected."
   */
  vendorOption(dialog: Locator, vendorLabel: string): Locator {
    return dialog.getByText(vendorLabel, { exact: true }).first();
  },

  nextButton(dialog: Locator): Locator {
    return dialog.getByRole('button', { name: /^Next$/ }).first();
  },

  /**
   * The XML upload control on step 2 of the wizard.
   *
   * `setInputFiles` drives the underlying `input[type=file]` directly, so no file chooser dialog is
   * involved and this works headless.
   */
  fileInput(dialog: Locator): Locator {
    return dialog.locator('input[type=file]').first();
  },
};

/* -------------------------------------------------------------------------------------------------
 * Shared helpers
 * ---------------------------------------------------------------------------------------------- */

/** Escapes a user-supplied string so it can be embedded in a RegExp safely. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Waits for the Lightning "toast" that reports the outcome of a Setup action, and returns its text.
 *
 * Useful because many Setup pages report failure only in a toast that disappears after a few seconds
 * — without capturing it, a failed action looks identical to a successful one.
 */
export async function readToast(page: Page, timeoutMs = 15_000): Promise<string | undefined> {
  const toast = page.locator('.slds-notify__content, .toastContent, [role="alert"]').first();
  const appeared = await toast
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return undefined;
  return (await toast.textContent())?.trim() ?? undefined;
}
