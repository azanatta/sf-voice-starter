/**
 * Phase 70 — Create the Lightning console app that hosts the softphone.
 *
 * ============================================================================================
 * WHAT THIS BUILDS, AND WHY IT IS METADATA RATHER THAN A BROWSER PHASE
 * ============================================================================================
 * A rep needs a **console** app whose utility bar carries two things:
 *
 *   - the telephony vendor's bridge component (e.g. `acme:AcmeVoiceBridge`), set to start
 *     automatically, and
 *   - Omni-Channel, because Voice calls arrive as Omni-Channel work items.
 *
 * The softphone does not render in a standard app, and an app the running user cannot see is no use,
 * so the app is also granted through a permission set.
 *
 * All three components are ordinary metadata, so no browser is involved. The definitions were
 * RETRIEVED from a working org rather than hand-written, then tokenised into `templates/app/` — that
 * way they match what Salesforce actually produces, which hand-written FlexiPage XML rarely does.
 *
 * ORDERING: the bridge component lives inside the vendor's MANAGED PACKAGE, so this metadata cannot
 * deploy into an org without that package. Two consequences:
 *   1. this phase runs after install-package, and
 *   2. the rendered files land in `app-src/`, a second package directory, NOT in `force-app/` — the
 *      latter is deployed by phase 20, long before the package exists, and would fail there.
 * ============================================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query, sf, SfCommandError } from '../sf.js';
import { requireOrg, type Phase, type PhaseContext } from '../types.js';

/** Second package directory, declared in sfdx-project.json. Its contents are generated. */
const APP_SRC = 'app-src/main/default';
const TEMPLATE_DIR = 'templates/app';

interface AppMenuItem {
  Name: string;
  Label: string;
}

export const consoleAppPhase: Phase = {
  id: 'console-app',
  title: 'Deploy the Lightning console app and its utility bar',

  // The bridge component is vendor-specific and has no sensible default, so it ships empty. Without
  // it the utility bar would render a FlexiPage referencing an empty component name, which deploys
  // to a broken app rather than failing — so skip the phase outright, the same way install-package
  // skips when no package version is configured.
  enabled: (ctx) =>
    ctx.config.consoleApp.create && ctx.config.consoleApp.bridgeComponent.trim() !== '',

  async run(ctx: PhaseContext) {
    const { developerName, accessPermissionSet } = ctx.config.consoleApp;

    renderTemplates(ctx);
    await deployApp(ctx);
    await verifyBridgeSurvivedDeploy(ctx);
    await assignAccess(ctx, accessPermissionSet);

    // Confirm the app is actually visible to the running user, not merely deployed.
    // NOTE: `AppMenuItem.Name` is not filterable — filtering returns zero rows instead of erroring —
    // so fetch and match in code. Same trap as elsewhere in this project.
    const apps = await query<AppMenuItem>(
      requireOrg(ctx).username,
      `SELECT Name, Label FROM AppMenuItem WHERE Type = 'TabSet'`,
    ).catch(() => undefined);

    const visible = apps?.records.some((app) => app.Name === developerName) ?? false;
    if (!visible) {
      ctx.log.warn(`App "${developerName}" deployed but is not visible to ${requireOrg(ctx).username}`);
      ctx.manualSteps.push(
        `The "${developerName}" app is not appearing in the App Launcher. Check that the ` +
          `"${accessPermissionSet}" permission set is assigned, or tick the app in the user's profile.`,
      );
      return;
    }

    ctx.log.success(`Console app "${developerName}" deployed and visible`);
    ctx.facts['Console app'] = `${developerName} (with Omni-Channel + vendor bridge)`;
  },
};

/**
 * Substitutes config values into the templates and writes them into the app-src package directory.
 *
 * The templates are tracked; the rendered output is not. Keeping the two separate means the vendor
 * bridge component and app name are configurable without anyone editing metadata by hand, and a
 * changed setting cannot leave a stale file behind — every run rewrites all three.
 */
function renderTemplates(ctx: PhaseContext): void {
  const app = ctx.config.consoleApp;

  const tokens: Record<string, string> = {
    APP_NAME: app.developerName,
    APP_LABEL: app.label,
    BRIDGE_COMPONENT: app.bridgeComponent,
    BRIDGE_LABEL: app.bridgeLabel,
    // "Start automatically" in the Setup UI.
    BRIDGE_EAGER: String(app.bridgeStartAutomatically),
    BRIDGE_WIDTH: String(app.bridgeWidth),
    BRIDGE_HEIGHT: String(app.bridgeHeight),
    // The identifier must be unique within the FlexiPage and cannot contain a colon, which the
    // component name does (`acme:AcmeVoiceBridge` -> `acme_AcmeVoiceBridge`).
    BRIDGE_IDENTIFIER: app.bridgeComponent.replace(/[^A-Za-z0-9]/g, '_'),
  };

  const outputs: Array<{ template: string; target: string }> = [
    {
      template: 'application.app-meta.xml',
      target: `applications/${app.developerName}.app-meta.xml`,
    },
    {
      template: 'utilityBar.flexipage-meta.xml',
      target: `flexipages/${app.developerName}_UtilityBar.flexipage-meta.xml`,
    },
    {
      template: 'appAccess.permissionset-meta.xml',
      target: `permissionsets/${app.accessPermissionSet}.permissionset-meta.xml`,
    },
  ];

  for (const { template, target } of outputs) {
    const templatePath = resolve(process.cwd(), TEMPLATE_DIR, template);
    if (!existsSync(templatePath)) {
      throw new Error(`Missing template ${templatePath}`);
    }

    let content = readFileSync(templatePath, 'utf8');
    for (const [token, value] of Object.entries(tokens)) {
      content = content.replaceAll(`{{${token}}}`, escapeXml(value));
    }

    const leftover = content.match(/\{\{([A-Z_]+)\}\}/);
    if (leftover) {
      throw new Error(
        `Template ${template} still contains an unsubstituted token ${leftover[0]}. ` +
          `Add it to the tokens map in src/phases/70-console-app.ts.`,
      );
    }

    const targetPath = resolve(process.cwd(), APP_SRC, target);
    mkdirSync(resolve(targetPath, '..'), { recursive: true });
    writeFileSync(targetPath, content, 'utf8');
  }

  ctx.log.step(
    `Rendered app "${app.developerName}" with utility items ` +
      `${app.bridgeComponent} (start automatically: ${app.bridgeStartAutomatically}) and Omni-Channel`,
  );
}

async function deployApp(ctx: PhaseContext): Promise<void> {
  const org = requireOrg(ctx);
  try {
    await sf(
      [
        'project',
        'deploy',
        'start',
        '--target-org',
        org.username,
        '--source-dir',
        'app-src',
        '--wait',
        '20',
        '--test-level',
        'NoTestRun',
      ],
      { timeoutMs: 25 * 60_000, onCommand: (c) => ctx.log.command(c) },
    );
    ctx.log.success('Console app, utility bar and access permission set deployed');
  } catch (error) {
    const detail = error instanceof SfCommandError ? error.message : String(error);
    throw new Error(
      `Deploying the console app failed: ${detail}\n\n` +
        `The most likely cause is that the utility bar references a component the org does not have: ` +
        `"${ctx.config.consoleApp.bridgeComponent}" ships inside the telephony vendor's managed ` +
        `package. Confirm the install-package phase succeeded, or set the bridge component to match ` +
        `your vendor's (SCV_BRIDGE_COMPONENT).`,
    );
  }
}

/**
 * Confirms the vendor bridge actually survived the deploy, by retrieving the FlexiPage back.
 *
 * ============================================================================================
 * THIS CHECK EXISTS BECAUSE A SUCCESSFUL DEPLOY PROVES NOTHING HERE
 * ============================================================================================
 * Deploying a utility bar that references `acme:AcmeVoiceBridge` into an org WITHOUT that managed
 * package does not fail. Salesforce accepts it, silently STRIPS the namespace, and stores
 * `AcmeVoiceBridge` — a component that does not resolve. The result is a green run and a console app
 * whose softphone utility is quietly broken.
 *
 * Observed exactly that: deployed `acme:AcmeVoiceBridge`, retrieved `AcmeVoiceBridge`, deploy reported
 * Succeeded throughout.
 *
 * So the only honest verification is a round trip.
 * ============================================================================================
 */
async function verifyBridgeSurvivedDeploy(ctx: PhaseContext): Promise<void> {
  const org = requireOrg(ctx);
  const { developerName, bridgeComponent } = ctx.config.consoleApp;
  const outputDir = 'generated/app-verify';

  let xml: string;
  try {
    await sf(
      [
        'project',
        'retrieve',
        'start',
        '--target-org',
        org.username,
        '--metadata',
        `FlexiPage:${developerName}_UtilityBar`,
        '--output-dir',
        outputDir,
      ],
      { onCommand: (c) => ctx.log.command(c) },
    );
    xml = readFileSync(
      resolve(process.cwd(), outputDir, 'flexipages', `${developerName}_UtilityBar.flexipage-meta.xml`),
      'utf8',
    );
  } catch {
    ctx.log.warn('Could not read the utility bar back to verify the bridge component');
    return;
  }

  if (xml.includes(`<componentName>${bridgeComponent}</componentName>`)) {
    ctx.log.success(`Bridge component "${bridgeComponent}" verified in the org`);
    return;
  }

  const stored = xml.match(/<componentName>(?!runtime_service_omnichannel)([^<]+)</)?.[1] ?? '(none)';
  throw new Error(
    `The utility bar was deployed but the bridge component did not survive it.\n` +
      `  expected: ${bridgeComponent}\n` +
      `  stored:   ${stored}\n\n` +
      `Salesforce strips a namespace it does not recognise instead of rejecting the deploy, so this ` +
      `almost always means the vendor's managed package is not installed in this org.\n` +
      `Check the install-package phase, or set SCV_BRIDGE_COMPONENT to match the package you do have.`,
  );
}

async function assignAccess(ctx: PhaseContext, permissionSet: string): Promise<void> {
  const org = requireOrg(ctx);
  try {
    await sf(['org', 'assign', 'permset', '--target-org', org.username, '--name', permissionSet], {
      onCommand: (c) => ctx.log.command(c),
    });
    ctx.log.success(`Assigned "${permissionSet}"`);
  } catch (error) {
    // Same duplicate-assignment shape as phase 40: the detail is buried in result.failures[].
    const haystack =
      error instanceof SfCommandError
        ? `${error.message} ${JSON.stringify(error.payload ?? '')}`.toLowerCase()
        : String(error).toLowerCase();
    if (haystack.includes('duplicate') || haystack.includes('already assigned')) {
      ctx.log.skip(`"${permissionSet}" assigned`);
      return;
    }
    throw error;
  }
}

/** Escapes the five XML entities so a label containing `&` or `<` cannot corrupt the metadata. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
