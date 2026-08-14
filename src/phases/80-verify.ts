/**
 * Phase 80 — Verify the org is genuinely ready.
 *
 * Runs the same checks the phases themselves rely on, but independently and from scratch, so that a
 * green run means something. Every check states what it looked at, so a red one is immediately
 * actionable.
 *
 * Runnable on its own against any org:  npm run verify
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { query, sf } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';
import { certificateExists } from './25-certificate.js';
import { isVoiceEnabled } from './30-enable-voice.js';
import { RENDERED_XML_PATH } from './55-render-contact-center.js';

interface Check {
  name: string;
  /** What was inspected — printed on failure so the reader can reproduce the check by hand. */
  probe: string;
  /** Whether a failure blocks package installation, or is merely a warning. */
  blocking: boolean;
  run: (ctx: PhaseContext) => Promise<{ ok: boolean; detail: string }>;
}

const checks: Check[] = [
  {
    name: 'Omni-Channel enabled',
    probe: "SELECT Id FROM ServiceChannel",
    blocking: true,
    async run(ctx) {
      const org = requireOrg(ctx);
      // ServiceChannel is only queryable once Omni-Channel is on; the query itself is the check.
      const result = await query(org.username, 'SELECT Id FROM ServiceChannel LIMIT 1').catch(
        () => undefined,
      );
      return result === undefined
        ? { ok: false, detail: 'ServiceChannel is not queryable — Omni-Channel appears to be off' }
        : { ok: true, detail: 'ServiceChannel is queryable' };
    },
  },
  {
    name: 'Voice (Partner Telephony) enabled',
    probe: 'sf project retrieve start --metadata Settings:ServiceCloudVoice',
    blocking: true,
    async run(ctx) {
      // The settings flag is the ONLY trustworthy signal. The Voice permission sets and permission
      // set license come from the scratch org features and exist while the toggle is still off, so
      // checking those would report success on an org where Voice is not enabled.
      const enabled = await isVoiceEnabled(ctx);
      return {
        ok: enabled,
        detail: enabled
          ? 'enableSCVExternalTelephony = true'
          : 'enableSCVExternalTelephony = false — Voice is NOT enabled',
      };
    },
  },
  {
    name: 'Voice permission sets exist',
    probe: "SELECT Name FROM PermissionSet WHERE Name LIKE 'ContactCenter%ExternalTelephony'",
    blocking: true,
    async run(ctx) {
      const org = requireOrg(ctx);
      const result = await query<{ Name: string }>(
        org.username,
        "SELECT Name FROM PermissionSet WHERE Name LIKE 'ContactCenter%ExternalTelephony'",
      );
      // Their absence means the org lacks the ServiceCloudVoicePartnerTelephony feature — a
      // different fault from Voice being switched off, hence a separate check.
      return {
        ok: result.totalSize > 0,
        detail:
          result.totalSize > 0
            ? `found ${result.totalSize} (created by the scratch org features, not by enablement)`
            : 'none — the org is missing the ServiceCloudVoicePartnerTelephony feature',
      };
    },
  },
  {
    name: 'Voice permission sets assigned to the running user',
    probe: 'SELECT PermissionSet.Name FROM PermissionSetAssignment',
    blocking: false,
    async run(ctx) {
      const org = requireOrg(ctx);
      const names = ctx.config.voice.permissionSets.map((n) => `'${n}'`).join(', ');
      const result = await query<{ PermissionSet: { Name: string } }>(
        org.username,
        `SELECT PermissionSet.Name FROM PermissionSetAssignment ` +
          `WHERE Assignee.Username = '${org.username}' AND PermissionSet.Name IN (${names})`,
      );
      const expected = ctx.config.voice.permissionSets.length;
      return {
        ok: result.totalSize >= expected,
        detail: `${result.totalSize} of ${expected} assigned`,
      };
    },
  },
  {
    name: 'Partner Telephony permission set license provisioned',
    probe: "SELECT DeveloperName FROM PermissionSetLicense",
    blocking: false,
    async run(ctx) {
      const org = requireOrg(ctx);
      const result = await query<{ TotalLicenses: number }>(
        org.username,
        `SELECT TotalLicenses FROM PermissionSetLicense ` +
          `WHERE DeveloperName = '${ctx.config.voice.permissionSetLicense}'`,
      );
      return {
        ok: result.totalSize > 0,
        detail:
          result.totalSize > 0
            ? `${result.records[0]?.TotalLicenses ?? '?'} license(s) available`
            : 'not provisioned — Voice users cannot be licensed in this org',
      };
    },
  },
  {
    name: 'Certificate exists',
    probe: "SELECT DeveloperName FROM Certificate (Tooling API)",
    blocking: false,
    async run(ctx) {
      if (!ctx.config.certificate.create) return { ok: true, detail: 'disabled by configuration' };
      const exists = await certificateExists(ctx);
      return {
        ok: exists,
        detail: exists
          ? ctx.config.certificate.developerName
          : `"${ctx.config.certificate.developerName}" is missing — the contact center's ` +
            'certDevName will not resolve and calls cannot be signed',
      };
    },
  },
  {
    name: 'Presence statuses exist',
    probe: 'SELECT MasterLabel FROM ServicePresenceStatus',
    blocking: false,
    async run(ctx) {
      if (!ctx.config.presence.create) return { ok: true, detail: 'disabled by configuration' };
      const org = requireOrg(ctx);
      const result = await query<{ MasterLabel: string }>(
        org.username,
        'SELECT MasterLabel FROM ServicePresenceStatus',
      );
      const labels = result.records.map((record) => record.MasterLabel);
      const wanted = [ctx.config.presence.readyStatusLabel, ctx.config.presence.notReadyStatusLabel];
      const missing = wanted.filter((label) => !labels.includes(label));
      return {
        ok: missing.length === 0,
        detail: missing.length === 0 ? labels.join(', ') : `missing: ${missing.join(', ')}`,
      };
    },
  },
  {
    name: 'Contact center carries real ids, not placeholders',
    probe: 'the rendered XML in generated/',
    blocking: false,
    async run(ctx) {
      // Checks the file that was actually imported. The CallCenter object does not expose the
      // vendor-defined items as queryable fields, so the rendered source is the honest thing to
      // assert on — and a placeholder left in it is exactly the silent failure worth catching.
      const rendered = resolve(process.cwd(), RENDERED_XML_PATH);
      // `generated/` is per-run and gitignored, so a missing file means this run did not render
      // one — NOT that the org's contact center is unconfigured. Say so, rather than passing green on
      // a check that inspected nothing.
      if (!existsSync(rendered)) {
        return { ok: true, detail: 'not checked — no rendered XML from this run' };
      }

      const xml = readFileSync(rendered, 'utf8');
      // reqTelephonyIntegrationCertificate is the field the Setup UI labels "Public Key". It is a
      // separate field from certDevName and both must be filled — checking only one is how the
      // empty-public-key bug survived a green run.
      const leftovers = [
        'readyStateId',
        'notReadyStateId',
        'certDevName',
        'reqTelephonyIntegrationCertificate',
      ].filter((item) => {
        const value = xml.match(new RegExp(`name="${item}"[^>]*>([^<]*)<`))?.[1]?.trim() ?? '';
        return value === '' || value.includes('&lt;') || value.includes('<');
      });
      return {
        ok: leftovers.length === 0,
        detail:
          leftovers.length === 0
            ? 'certDevName, Public Key, readyStateId and notReadyStateId are all filled in'
            : `still placeholder/empty: ${leftovers.join(', ')}`,
      };
    },
  },
  {
    name: 'User is in the contact center',
    probe: 'SELECT CallCenterId FROM User',
    blocking: false,
    async run(ctx) {
      if (!ctx.config.contactCenter.create) return { ok: true, detail: 'disabled by configuration' };
      const org = requireOrg(ctx);
      const result = await query<{ CallCenterId: string | null }>(
        org.username,
        `SELECT CallCenterId FROM User WHERE Username = '${org.username}'`,
      );
      const assigned = result.records[0]?.CallCenterId;
      return {
        ok: Boolean(assigned),
        detail: assigned ? `CallCenterId = ${assigned}` : 'not assigned to any contact center',
      };
    },
  },
  {
    name: 'CSP trusted sites deployed',
    probe: 'sf project retrieve start --metadata CspTrustedSite',
    blocking: false,
    async run(ctx) {
      if (ctx.config.csp.sites.length === 0) return { ok: true, detail: 'none configured' };
      const org = requireOrg(ctx);
      // No queryable object for these, so read them back as metadata.
      const outputDir = 'generated/csp-verify';
      rmSync(resolve(process.cwd(), outputDir), { recursive: true, force: true });
      await sf([
        'project', 'retrieve', 'start',
        '--target-org', org.username,
        '--metadata', 'CspTrustedSite',
        '--output-dir', outputDir,
      ]).catch(() => undefined);

      const dir = resolve(process.cwd(), outputDir, 'cspTrustedSites');
      const files = existsSync(dir) ? readdirSync(dir) : [];
      const urls = files
        .map((file) => readFileSync(resolve(dir, file), 'utf8'))
        .map((xml) => xml.match(/<endpointUrl>([^<]+)</)?.[1])
        .filter((url): url is string => Boolean(url));

      const wanted = ctx.config.csp.sites.map((entry) =>
        (entry.includes('|') ? entry.slice(entry.indexOf('|') + 1) : entry).trim(),
      );
      const missing = wanted.filter((url) => !urls.includes(url));
      return {
        ok: missing.length === 0,
        detail: missing.length === 0 ? `${urls.length} site(s) present` : `missing: ${missing.join(', ')}`,
      };
    },
  },
  {
    name: 'Console app is visible with a working bridge',
    probe: "SELECT Name FROM AppMenuItem WHERE Type = 'TabSet'",
    blocking: false,
    async run(ctx) {
      if (!ctx.config.consoleApp.create) return { ok: true, detail: 'disabled by configuration' };
      const org = requireOrg(ctx);
      // AppMenuItem.Name is not filterable — filtering returns zero rows rather than erroring.
      const apps = await query<{ Name: string }>(
        org.username,
        "SELECT Name FROM AppMenuItem WHERE Type = 'TabSet'",
      ).catch(() => undefined);
      const visible =
        apps?.records.some((app) => app.Name === ctx.config.consoleApp.developerName) ?? false;
      return {
        ok: visible,
        detail: visible
          ? `${ctx.config.consoleApp.developerName} is in the App Launcher`
          : `${ctx.config.consoleApp.developerName} is not visible to ${org.username}`,
      };
    },
  },
  {
    name: 'A telephony vendor is available',
    probe: 'SELECT DeveloperName FROM ConversationVendorInfo',
    blocking: false,
    async run(ctx) {
      const org = requireOrg(ctx);
      const result = await query<{ DeveloperName: string }>(
        org.username,
        'SELECT DeveloperName FROM ConversationVendorInfo',
      ).catch(() => undefined);
      const names = result?.records.map((r) => r.DeveloperName) ?? [];
      return {
        ok: names.length > 0,
        detail:
          names.length > 0
            ? names.join(', ')
            : 'none — expected until the vendor package is installed',
      };
    },
  },
];

export const verifyPhase: Phase = {
  id: 'verify',
  title: 'Verify org readiness',

  async run(ctx: PhaseContext) {
    const failures: string[] = [];

    for (const check of checks) {
      let ok = false;
      let detail = '';
      try {
        const outcome = await check.run(ctx);
        ok = outcome.ok;
        detail = outcome.detail;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }

      if (ok) {
        ctx.log.success(`${check.name} — ${detail}`);
      } else if (check.blocking) {
        ctx.log.error(`${check.name} — ${detail}`);
        failures.push(`${check.name}: ${detail}\n      probe: ${check.probe}`);
      } else {
        ctx.log.warn(`${check.name} — ${detail}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The org is NOT ready to install a Service Cloud Voice package.\n\n` +
          failures.map((f) => `  - ${f}`).join('\n\n'),
      );
    }
  },
};
