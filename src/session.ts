/**
 * Authenticated browser sessions, derived from the Salesforce CLI's stored auth.
 *
 * WHY THIS EXISTS
 * ---------------
 * The obvious way to get Playwright into a Salesforce org is to automate the login form. Do not do
 * that. It requires storing a username and password, it breaks the moment MFA is enforced (which it
 * is, by default, on every org that matters), and it produces a script that cannot run in CI.
 *
 * Instead we ask the CLI for its short-lived browser-login URL with `sf org open --url-only` and
 * navigate to it. No credentials exist anywhere in this repo, MFA is irrelevant because the CLI
 * already satisfied it, and the same code runs headless.
 *
 * SECURITY NOTE
 * -------------
 * The CLI-generated URL contains a short-lived one-time password rather than the reusable API access
 * token. It is never logged; `src/sf.ts` logs only the command that generated it.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import type { ScvSetupConfig } from '../config/scv-setup.config.js';
import type { Logger } from './logger.js';
import { orgDisplay, orgOpenUrl, type OrgDisplay } from './sf.js';

export interface BrowserSession {
  browser: Browser;
  page: Page;
  org: OrgDisplay;
}

/**
 * Launches a browser and lands it on an authenticated Setup page for `orgAlias`.
 *
 * The returned page is ready for navigation to any Setup URL via `gotoSetup()`.
 */
export async function openAuthenticatedSession(
  orgAlias: string,
  config: ScvSetupConfig,
  log: Logger,
): Promise<BrowserSession> {
  const org = await orgDisplay(orgAlias, { onCommand: (c) => log.command(c) });

  log.step(`Launching browser against ${org.instanceUrl}`);
  const browser = await chromium.launch({
    headless: !config.runtime.headed,
    slowMo: config.runtime.slowMoMs,
  });

  const context = await browser.newContext({
    // Salesforce Setup is a desktop-first app; a small viewport hides utility bars and collapses
    // the Setup tree into menus that the selectors do not expect.
    viewport: { width: 1600, height: 1000 },
    // Some Setup pages render an "unsupported browser" interstitial for unknown user agents.
    ignoreHTTPSErrors: false,
  });
  context.setDefaultTimeout(config.runtime.actionTimeoutMs);
  context.setDefaultNavigationTimeout(config.runtime.navigationTimeoutMs);

  const page = await context.newPage();

  const login = await orgOpenUrl(orgAlias, { onCommand: (c) => log.command(c) });
  await page.goto(login.url, { waitUntil: 'domcontentloaded' });

  if (isAuthenticationTransition(new URL(page.url()))) {
    await page.waitForURL((url) => !isAuthenticationTransition(url), {
      timeout: config.runtime.navigationTimeoutMs,
    });
  }

  await page.waitForLoadState('domcontentloaded');

  // Let Salesforce's post-login redirect chain finish before anyone navigates.
  // frontdoor.jsp is not the last hop — it can bounce through /secur/contentDoor on the
  // *.file.force.com domain before settling. Navigating during that chain fails the next goto with
  // "interrupted by another navigation".
  await page.waitForLoadState('networkidle').catch(() => {
    // Lightning holds long-poll connections open, so networkidle may never arrive. The retry in
    // gotoSetup covers the remaining race.
  });

  // A failed frontdoor exchange bounces to the login page instead of erroring, so check explicitly.
  // Catching it here turns a confusing "selector not found" 60 seconds later into an immediate,
  // accurate diagnosis.
  if (await isLoginPage(page)) {
    await browser.close();
    throw new Error(
      `Session exchange failed for org "${orgAlias}" — the browser was redirected to the login page.\n` +
        `The CLI's access token is probably expired. Refresh it with:\n` +
        `  sf org open --target-org ${orgAlias}`,
    );
  }

  log.success('Browser session authenticated (no credentials used)');
  return { browser, page, org };
}

/**
 * Navigates to a Setup page by its stable Setup node path.
 *
 * Always prefer this over clicking through the Setup tree. The tree's structure, labels and search
 * behaviour change between releases; the `/lightning/setup/<node>/home` URLs are far more stable and
 * skip 3-4 flaky interactions per navigation.
 *
 * @param node The Setup node id, e.g. `VoiceSettings`, `CallCenters`, `PermSets`.
 */
export async function gotoSetup(page: Page, node: string, log?: Logger): Promise<void> {
  // NOTE ON ORIGINS: Setup redirects from `<instance>.my.salesforce.com` to
  // `<instance>.my.salesforce-setup.com` — a genuinely different origin. Deriving the origin from
  // the CURRENT url (rather than hardcoding the instance URL) means repeat navigations stay on
  // whichever domain Setup has already put us on, instead of bouncing between the two.
  const origin = new URL(page.url()).origin;
  log?.step(`Opening Setup → ${node}`);

  // Salesforce fires its own client-side redirects during and after login, and one of them landing
  // mid-`goto` aborts our navigation with net::ERR_ABORTED. This is transient by nature — the retry
  // succeeds — so retry rather than failing the phase. Observed on the very first Setup navigation
  // after a session exchange.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(`${origin}/lightning/setup/${node}/home`, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Two spellings of the same transient problem, both observed against real orgs:
      //   - "net::ERR_ABORTED"                     (our navigation cancelled by a redirect)
      //   - "interrupted by another navigation"    (Salesforce's own login redirect chain, e.g. the
      //                                             /secur/contentDoor hop that follows frontdoor)
      const isTransientRedirect =
        message.includes('ERR_ABORTED') || message.includes('interrupted by another navigation');
      if (!isTransientRedirect || attempt === maxAttempts) throw error;
      log?.step(`Navigation to ${node} was interrupted by a redirect; retrying (${attempt}/${maxAttempts})`);
      await page.waitForTimeout(2_000);
    }
  }

  // Lightning renders asynchronously long after `domcontentloaded`. Waiting for the network to go
  // quiet is the cheapest reliable proxy for "the page has actually drawn".
  await page.waitForLoadState('networkidle').catch(() => {
    // Some Setup pages hold long-poll connections open and never reach networkidle. Falling through
    // is correct — the individual step's own locator wait provides the real synchronisation.
  });

  if (await isLoginPage(page)) {
    throw new Error(
      `Setup navigation to "${node}" was redirected to the Salesforce login page.\n` +
        'The CLI session may have expired. Refresh it with:\n' +
        '  sf org open --target-org <your-org-alias>\n' +
        'Then re-run the setup command.',
    );
  }
}

async function isLoginPage(page: Page): Promise<boolean> {
  if (/\/login\.jsp|\/secur\/logout\.jsp/.test(page.url())) return true;
  return (await page.locator('#login_form, form[name="login"]').count()) > 0;
}

function isAuthenticationTransition(url: URL): boolean {
  return url.pathname.endsWith('/secur/frontdoor.jsp') || url.pathname.endsWith('/secur/contentDoor');
}

/**
 * Many classic Setup pages are served inside an iframe embedded in a Lightning shell. Locators
 * resolved against `page` will silently miss them.
 *
 * This returns something you can chain locators off, transparently handling both cases.
 */
export async function setupFrame(page: Page) {
  const iframe = page.locator('iframe[title*="Setup"], iframe[name^="vfFrameId"], force-aloha-page iframe');
  if ((await iframe.count()) > 0) {
    return page.frameLocator(
      'iframe[title*="Setup"], iframe[name^="vfFrameId"], force-aloha-page iframe',
    );
  }
  return page;
}
