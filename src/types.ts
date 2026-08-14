/**
 * Shared types for the phase pipeline.
 *
 * The pipeline is intentionally simple: an ordered list of phases, each of which can decide it has
 * nothing to do. There is no dependency graph, because the real ordering constraints here are strict
 * and linear (you cannot assign a Voice permission set before Voice exists; you cannot create a
 * contact center before the vendor package is installed) and a graph would only hide that.
 */

import type { Browser, Page } from '@playwright/test';
import type { ScvSetupConfig } from '../config/scv-setup.config.js';
import type { Logger } from './logger.js';
import type { OrgDisplay } from './sf.js';

export interface PhaseContext {
  config: ScvSetupConfig;
  log: Logger;

  /**
   * Details of the scratch org, populated by the create-org phase. Phases that need it should call
   * `requireOrg(ctx)` rather than asserting non-null themselves, so the failure message is uniform.
   */
  org?: OrgDisplay;

  /**
   * Lazily-created browser session. UI phases call `ctx.ui()`; phases that need no browser never
   * trigger one, which keeps a metadata-only run fast and headless-dependency-free.
   */
  ui: () => Promise<Page>;

  /** Kept so the runner can close it at the end regardless of which phases ran. */
  browser?: Browser;

  /** Follow-ups the script could not perform, surfaced in the final report. */
  manualSteps: string[];

  /** Facts gathered during the run, printed as the closing summary. */
  facts: Record<string, string>;
}

export interface Phase {
  /** Stable short id used for `--only=` / `--skip=` selection and for log lines. */
  id: string;
  /** Human-readable one-liner shown when the phase starts. */
  title: string;
  /**
   * Whether this phase drives a browser. Used to fail fast with a clear message when Playwright
   * browsers are not installed, rather than deep inside a step.
   */
  usesBrowser?: boolean;
  /** Skip the phase entirely based on configuration. */
  enabled?: (ctx: PhaseContext) => boolean;
  /** Do the work. Must be idempotent: safe to re-run against a partially configured org. */
  run: (ctx: PhaseContext) => Promise<void>;
}

/** Narrows `ctx.org` with a uniform, actionable error. */
export function requireOrg(ctx: PhaseContext): OrgDisplay {
  if (!ctx.org) {
    throw new Error(
      'No target org in context. The create-org phase must run first, or pass --org=<alias> to ' +
        'operate on an existing org.',
    );
  }
  return ctx.org;
}
