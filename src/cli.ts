#!/usr/bin/env node
/**
 * Entry point: runs the setup phases in order.
 *
 * Usage:
 *   npm run setup                          Run everything
 *   npm run setup -- --headed              Run with a visible browser (selector debugging)
 *   npm run setup -- --only=enable-voice   Run one phase (repeatable, comma-separated)
 *   npm run setup -- --skip=install-package
 *   npm run setup -- --org=my-existing-org Operate on an existing org, skipping creation
 *   npm run setup -- --no-reuse            Force a brand new scratch org
 *   npm run setup -- --delete              Delete the configured scratch org and exit
 *   npm run setup -- --list                List phases and exit
 *
 * Exit codes: 0 success, 1 a phase failed, 2 bad usage.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { config as baseConfig } from '../config/scv-setup.config.js';
import { logger, style } from './logger.js';
import { openAuthenticatedSession } from './session.js';
import { sf, SfCommandError } from './sf.js';
import type { Phase, PhaseContext } from './types.js';

import { preflightPhase } from './phases/00-preflight.js';
import { createOrgPhase } from './phases/10-create-org.js';
import { deploySettingsPhase } from './phases/20-deploy-settings.js';
import { cspTrustedSitesPhase } from './phases/22-csp-trusted-sites.js';
import { certificatePhase } from './phases/25-certificate.js';
import { enableVoicePhase } from './phases/30-enable-voice.js';
import { permissionsPhase } from './phases/40-permissions.js';
import { installPackagePhase } from './phases/50-install-package.js';
import { renderContactCenterPhase } from './phases/55-render-contact-center.js';
import { contactCenterPhase } from './phases/60-contact-center.js';
import { contactCenterUsersPhase } from './phases/65-contact-center-users.js';
import { consoleAppPhase } from './phases/70-console-app.js';
import { verifyPhase } from './phases/80-verify.js';

/**
 * The pipeline, in execution order.
 *
 * The ordering encodes real constraints, not preferences:
 *   - The certificate and the presence statuses must exist before the contact center XML can be
 *     rendered with their ids (55 after 25 and after the settings deploy).
 *   - The vendor package must be installed before a contact center can reference its vendor
 *     info (60 after 50), and the Partner Telephony permission set must be assigned before the
 *     contact centers Setup page is even visible (60 after 40).
 *   - The contact center must exist before a user can be added to it (65 after 60).
 */
const PHASES: Phase[] = [
  preflightPhase,
  createOrgPhase,
  deploySettingsPhase,
  cspTrustedSitesPhase,
  certificatePhase,
  enableVoicePhase,
  permissionsPhase,
  installPackagePhase,
  renderContactCenterPhase,
  contactCenterPhase,
  contactCenterUsersPhase,
  consoleAppPhase,
  verifyPhase,
];

interface CliOptions {
  only: Set<string>;
  skip: Set<string>;
  headed: boolean;
  orgOverride?: string;
  noReuse: boolean;
  deleteOrg: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    only: new Set(),
    skip: new Set(),
    headed: false,
    noReuse: false,
    deleteOrg: false,
    list: false,
  };

  for (const arg of argv) {
    if (arg === '--headed') options.headed = true;
    else if (arg === '--no-reuse') options.noReuse = true;
    else if (arg === '--delete') options.deleteOrg = true;
    else if (arg === '--list') options.list = true;
    else if (arg.startsWith('--only=')) {
      for (const id of arg.slice('--only='.length).split(',')) options.only.add(id.trim());
    } else if (arg.startsWith('--skip=')) {
      for (const id of arg.slice('--skip='.length).split(',')) options.skip.add(id.trim());
    } else if (arg.startsWith('--org=')) {
      options.orgOverride = arg.slice('--org='.length).trim();
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  const known = new Set(PHASES.map((phase) => phase.id));
  for (const id of [...options.only, ...options.skip]) {
    if (!known.has(id)) {
      console.error(`Unknown phase "${id}". Known phases: ${[...known].join(', ')}`);
      process.exit(2);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    for (const phase of PHASES) console.log(`${phase.id.padEnd(22)} ${phase.title}`);
    return;
  }

  // Apply CLI overrides on top of the config file.
  const config = structuredClone(baseConfig);
  if (options.headed) config.runtime.headed = true;
  if (options.noReuse) config.scratchOrg.reuseIfExists = false;
  if (options.orgOverride) config.scratchOrg.alias = options.orgOverride;

  mkdirSync(resolve(process.cwd(), config.runtime.artifactDir), { recursive: true });

  if (options.deleteOrg) {
    await deleteOrg(config.scratchOrg.alias);
    return;
  }

  let browser: Browser | undefined;
  let page: Page | undefined;

  const ctx: PhaseContext = {
    config,
    log: logger,
    manualSteps: [],
    facts: {},
    /**
     * Lazily opens the browser. A run that needs no UI phase never launches Chromium, which keeps
     * the common (fully-automated) path fast and means a missing browser binary only matters when a
     * browser is genuinely required.
     */
    async ui(): Promise<Page> {
      if (page) return page;
      const org = ctx.org;
      if (!org) throw new Error('Cannot open a browser session before the target org is known.');
      const session = await openAuthenticatedSession(org.username, config, logger);
      browser = session.browser;
      ctx.browser = session.browser;
      page = session.page;
      return page;
    },
  };

  const selected = PHASES.filter((phase) => {
    if (options.only.size > 0) return options.only.has(phase.id);
    return !options.skip.has(phase.id);
  });

  // When the create-org phase is not going to run, the org still has to come from somewhere.
  // Resolve it from the configured alias up front so that `--only=verify`, `--skip=create-org` and
  // `--org=<alias>` all work standalone instead of failing with "no target org in context".
  // A failure here is not fatal: create-org may legitimately be in the selection and about to make it.
  const willCreateOrg = selected.some((phase) => phase.id === createOrgPhase.id);
  // preflight is the one phase that inspects the Dev Hub rather than the scratch org, so a
  // preflight-only run must not complain about a scratch org it was never going to touch.
  const needsOrg = selected.some((phase) => phase.id !== preflightPhase.id);

  if (!willCreateOrg && needsOrg) {
    const alias = options.orgOverride ?? config.scratchOrg.alias;
    ctx.org = await sf<typeof ctx.org>(['org', 'display', '--target-org', alias]).catch(() => {
      logger.warn(`Could not resolve org "${alias}" — phases that need one will fail.`);
      return undefined;
    });
  }

  const started = Date.now();
  let failed: { phase: Phase; error: unknown } | undefined;

  try {
    for (const phase of selected) {
      if (phase.enabled && !phase.enabled(ctx)) {
        logger.phase(phase.id, phase.title);
        logger.skip('Disabled by configuration');
        continue;
      }

      logger.phase(phase.id, phase.title);
      try {
        await phase.run(ctx);
      } catch (error) {
        failed = { phase, error };
        break;
      }

      if (phase.usesBrowser && page && config.runtime.screenshotEveryPhase) {
        await screenshot(page, config.runtime.artifactDir, phase.id);
      }
    }
  } finally {
    if (failed && page) {
      // A screenshot of the failure is worth more than the stack trace for UI phases.
      await screenshot(page, config.runtime.artifactDir, `FAILED-${failed.phase.id}`);
    }
    await browser?.close();
  }

  printSummary(ctx, started, failed);

  if (failed) process.exitCode = 1;
}

async function screenshot(page: Page, dir: string, name: string): Promise<void> {
  const path = resolve(process.cwd(), dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => {
    // A screenshot failure must never mask the real error.
  });
}

async function deleteOrg(alias: string): Promise<void> {
  logger.phase('delete', `Delete scratch org "${alias}"`);
  try {
    await sf(['org', 'delete', 'scratch', '--target-org', alias, '--no-prompt'], {
      onCommand: (c) => logger.command(c),
    });
    logger.success(`Deleted "${alias}"`);
  } catch (error) {
    const detail = error instanceof SfCommandError ? error.message : String(error);
    logger.error(`Could not delete "${alias}": ${detail}`);
    process.exitCode = 1;
  }
}

function printSummary(
  ctx: PhaseContext,
  started: number,
  failed: { phase: Phase; error: unknown } | undefined,
): void {
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`\n${'─'.repeat(78)}\n`);

  if (failed) {
    const message = failed.error instanceof Error ? failed.error.message : String(failed.error);
    process.stdout.write(`${style.red('FAILED')} in phase "${failed.phase.id}" after ${seconds}s\n\n`);
    process.stdout.write(`${message}\n`);
    if (failed.error instanceof SfCommandError) {
      process.stdout.write(`\n${style.dim(`Command: sf ${failed.error.args.join(' ')}`)}\n`);
    }
    // Only suggest --headed for phases that can actually open a browser; on a CLI-only phase it does
    // nothing and sends the reader looking for a UI problem that isn't there.
    const headedHint = failed.phase.usesBrowser ? ' --headed' : '';
    process.stdout.write(
      `\n${style.dim(`Re-run just this phase:  npm run setup -- --only=${failed.phase.id}${headedHint}`)}\n`,
    );
  } else {
    process.stdout.write(`${style.green('SUCCESS')} in ${seconds}s\n`);
  }

  if (Object.keys(ctx.facts).length > 0) {
    process.stdout.write(`\n${style.bold('Org')}\n`);
    for (const [key, value] of Object.entries(ctx.facts)) {
      process.stdout.write(`  ${key.padEnd(28)} ${value}\n`);
    }
  }

  if (ctx.manualSteps.length > 0) {
    process.stdout.write(`\n${style.bold('Manual follow-ups')}\n`);
    ctx.manualSteps.forEach((step, index) => {
      process.stdout.write(`  ${index + 1}. ${step}\n\n`);
    });
  }

  if (ctx.org) {
    process.stdout.write(
      `${style.dim(`Open the org:  sf org open --target-org ${ctx.config.scratchOrg.alias}`)}\n`,
    );
  }
  process.stdout.write(`${'─'.repeat(78)}\n`);
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
