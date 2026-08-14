/**
 * Verification tests for a prepared org.
 *
 * These do NOT set anything up — run `npm run setup` first. They answer one question:
 * "is this org actually ready for a Service Cloud Voice package?"
 *
 * Run against the configured scratch org:            npm test
 * Run against any other org:            SCV_ORG_ALIAS=my-org npm test
 *
 * Most assertions are SOQL rather than UI, deliberately: querying the org is faster and far more
 * stable than scraping Setup, and the facts we care about (permission sets, licenses, vendor infos)
 * are all queryable. The one UI test exists to prove the *browser session mechanism* works, since
 * the setup script depends on it for the phases that have no API.
 */

import { expect, test } from '@playwright/test';
import { config } from '../config/scv-setup.config.js';
import { gotoSetup, openAuthenticatedSession } from '../src/session.js';
import { logger } from '../src/logger.js';
import { isVoiceEnabled } from '../src/phases/30-enable-voice.js';
import { resolveInternalName } from '../src/phases/60-contact-center.js';
import { orgDisplay, query } from '../src/sf.js';
import { voiceSettingsPage } from '../src/ui/selectors.js';

const orgAlias = config.scratchOrg.alias;

test.describe('Org readiness for a Service Cloud Voice package', () => {
  test('the org is reachable via the CLI', async () => {
    const org = await orgDisplay(orgAlias);
    expect(org.instanceUrl, 'org should have an instance URL').toBeTruthy();
    expect(org.accessToken, 'org should have a usable access token').toBeTruthy();
  });

  test('Omni-Channel is enabled', async () => {
    const org = await orgDisplay(orgAlias);
    // ServiceChannel only becomes queryable once Omni-Channel is on, so a successful query is the
    // assertion. Voice calls are routed as Omni-Channel work items, so this is a hard prerequisite.
    const result = await query(org.username, 'SELECT Id FROM ServiceChannel LIMIT 1');
    expect(result.done, 'ServiceChannel should be queryable').toBe(true);
  });

  test('Service Cloud Voice with Partner Telephony is enabled', async () => {
    const org = await orgDisplay(orgAlias);

    // The settings flag is the ONLY trustworthy enablement signal.
    //
    // It is tempting to check for the ContactCenter*ExternalTelephony permission sets instead — they
    // look like a perfect proxy. They are not: the scratch org FEATURES create them, so they are
    // present in an org where the toggle is still off. Verified by observing exactly that state.
    const enabled = await isVoiceEnabled({
      config,
      log: logger,
      org,
      manualSteps: [],
      facts: {},
      ui: async () => {
        throw new Error('unused');
      },
    });

    expect(enabled, 'enableSCVExternalTelephony should be true').toBe(true);
  });

  test('the Voice permission sets exist', async () => {
    const org = await orgDisplay(orgAlias);
    // A separate fault from Voice being off: their absence means the org was created without the
    // ServiceCloudVoicePartnerTelephony feature.
    const result = await query<{ Name: string }>(
      org.username,
      "SELECT Name FROM PermissionSet WHERE Name LIKE 'ContactCenter%ExternalTelephony'",
    );
    expect(
      result.totalSize,
      'expected the three ContactCenter*ExternalTelephony permission sets from the scratch org features',
    ).toBeGreaterThan(0);
  });

  test('the Voice permission sets are assigned to the running user', async () => {
    const org = await orgDisplay(orgAlias);
    const names = config.voice.permissionSets.map((name) => `'${name}'`).join(', ');
    const result = await query(
      org.username,
      `SELECT PermissionSet.Name FROM PermissionSetAssignment ` +
        `WHERE Assignee.Username = '${org.username}' AND PermissionSet.Name IN (${names})`,
    );
    expect(result.totalSize).toBe(config.voice.permissionSets.length);
  });

  test('the Partner Telephony permission set license is provisioned', async () => {
    const org = await orgDisplay(orgAlias);
    const result = await query<{ TotalLicenses: number }>(
      org.username,
      `SELECT TotalLicenses FROM PermissionSetLicense ` +
        `WHERE DeveloperName = '${config.voice.permissionSetLicense}'`,
    );

    // Soft check: an org created without the ServiceCloudVoicePartnerTelephony feature can still
    // install a package, it just cannot license many Voice users. Fail with an explanation rather
    // than a bare assertion so the reader knows whether they care.
    expect(
      result.totalSize,
      `"${config.voice.permissionSetLicense}" is not provisioned. The org was likely created ` +
        'without the ServiceCloudVoicePartnerTelephony scratch org feature — see ' +
        'config/README-scratch-def.md.',
    ).toBeGreaterThan(0);
  });

  test('the contact center was imported', async () => {
    const org = await orgDisplay(orgAlias);
    // Same resolution the phase uses, so the test cannot drift from what was actually imported.
    const internalName = resolveInternalName(config);
    const result = await query<{ InternalName: string }>(
      org.username,
      `SELECT InternalName FROM CallCenter WHERE InternalName = '${internalName}'`,
    );

    // Skipped rather than failed when no vendor XML is configured: stopping at "ready to install" is
    // a legitimate way to use this project, and a red test there would be noise rather than signal.
    test.skip(
      !config.contactCenter.create || config.contactCenter.definitionFile.trim() === '',
      'no contact center XML configured',
    );

    expect(
      result.totalSize,
      `expected a CallCenter with InternalName "${internalName}". Note this must ` +
        'match the <item name="reqInternalName"> value in the vendor XML.',
    ).toBeGreaterThan(0);
  });

  test('the Salesforce Voice Setup page renders and its toggle is findable', async () => {
    // Proves two things the setup script's UI fallback depends on:
    //   1. the credential-free session mechanism works, and
    //   2. the Setup node and toggle selector still match.
    //
    // Worth keeping even though Voice is normally enabled by metadata: when the fallback is finally
    // needed, it will be on an org where something has already gone wrong, and a selector that
    // rotted silently months earlier is the worst time to discover it.
    const session = await openAuthenticatedSession(orgAlias, config, logger);
    try {
      await gotoSetup(session.page, voiceSettingsPage.setupNode, logger);
      expect(session.page.url(), 'should not be bounced to the login page').not.toMatch(/login\.jsp/);

      const toggle = voiceSettingsPage.partnerTelephonyToggle(session.page);
      await toggle.waitFor({ state: 'attached', timeout: config.runtime.navigationTimeoutMs });

      expect(
        await toggle.count(),
        'the "Turn on Voice with Partner Telephony" toggle should be findable. If this fails, either ' +
          'the Setup node changed or the org lacks the Voice scratch org features (the page then ' +
          'hangs on a spinner with a "CSS Error" banner rather than 404ing).',
      ).toBeGreaterThan(0);

      // After a successful setup the toggle must read as on.
      expect(await voiceSettingsPage.isToggleOn(toggle)).toBe(true);
    } finally {
      await session.browser.close();
    }
  });
});
