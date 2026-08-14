/**
 * Phase 10 — Create (or adopt) the scratch org.
 *
 * Idempotency: if an org with the configured alias already exists and has not expired, it is reused
 * rather than recreated. Re-running the whole setup against a half-configured org is the common case
 * when a later phase fails, and burning a fresh org each time exhausts Dev Hub limits fast.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { orgDisplay, sf, sfOptional, SfCommandError, type OrgDisplay } from '../sf.js';
import type { Phase, PhaseContext } from '../types.js';

/** Where the effective (merged) scratch definition is written before use. */
const GENERATED_DEF = 'generated/effective-scratch-def.json';

export const createOrgPhase: Phase = {
  id: 'create-org',
  title: 'Create or adopt the scratch org',

  async run(ctx: PhaseContext) {
    const { alias } = ctx.config.scratchOrg;

    if (ctx.config.scratchOrg.reuseIfExists) {
      const existing = await adoptExistingOrg(alias, ctx);
      if (existing) {
        ctx.org = existing;
        ctx.facts['Scratch org'] = `${existing.username} (reused)`;
        return;
      }
    }

    ctx.org = await createOrg(ctx);
    ctx.facts['Scratch org'] = `${ctx.org.username} (created)`;
  },
};

/** Returns the org if it exists and is usable, otherwise undefined. */
async function adoptExistingOrg(alias: string, ctx: PhaseContext): Promise<OrgDisplay | undefined> {
  const existing = await sfOptional<OrgDisplay>(['org', 'display', '--target-org', alias]);
  if (!existing) return undefined;

  // An expired scratch org still resolves by alias but rejects every real operation.
  if (existing.status && existing.status !== 'Active') {
    ctx.log.warn(`Org "${alias}" exists but its status is "${existing.status}" — creating a new one`);
    return undefined;
  }
  if (existing.expirationDate && new Date(existing.expirationDate) < new Date()) {
    ctx.log.warn(`Org "${alias}" expired on ${existing.expirationDate} — creating a new one`);
    return undefined;
  }

  ctx.log.skip(`Reusing existing scratch org "${alias}" (${existing.username})`);
  ctx.log.step(`Pass --no-reuse (or set SCV_REUSE_ORG=false) to force a fresh org`);
  return existing;
}

async function createOrg(ctx: PhaseContext): Promise<OrgDisplay> {
  const { alias, durationDays } = ctx.config.scratchOrg;
  // Attempt 1: the fast path, with the Voice features from the definition file.
  const defPath = writeEffectiveDefinition(ctx, /* includeVoiceFeatures */ true);
  const voiceFeatures = readVoiceFeatures(defPath);

  if (voiceFeatures.length > 0) {
    try {
      ctx.log.step(`Creating org with Voice features: ${voiceFeatures.join(', ')}`);
      await runCreate(ctx, defPath);
      ctx.log.success('Scratch org created with Partner Telephony licenses provisioned');
      return await orgDisplay(alias, { onCommand: (c) => ctx.log.command(c) });
    } catch (error) {
      if (!isLikelyFeatureEntitlementFailure(error)) throw error;

      // See config/README-scratch-def.md and forcedotcom/cli#1495. The server returns an opaque
      // error rather than naming the feature, so this branch is a heuristic — it is deliberately
      // narrow, and it says exactly what it assumed.
      ctx.log.warn(
        'Org creation failed in the way a missing Voice feature entitlement looks ' +
          '(opaque server error, no error code — forcedotcom/cli#1495).',
      );
      ctx.log.warn('Retrying without the Voice features; Voice will be enabled through the Setup UI instead.');
      ctx.manualSteps.push(
        `Dev Hub "${ctx.config.devHub.alias}" could not provision these scratch org features: ` +
          `${voiceFeatures.join(', ')}. Voice was enabled via the Setup UI instead, but the Partner ` +
          `Telephony permission set LICENSES may be absent, which caps how many users you can assign — ` +
          `and without Scrt2Conversation the Voice Settings page may not render at all. Ask Salesforce ` +
          `to enable these features on the Dev Hub for a clean setup.`,
      );
    }
  } else {
    ctx.log.warn(
      'No Voice features found in the scratch definition. Setup → Salesforce Voice will not render ' +
        'without ServiceCloudVoicePartnerTelephony, Scrt2Conversation and BYOOTT.',
    );
  }

  // Attempt 2: create without the Voice features. Voice gets turned on downstream.
  const fallbackDef = writeEffectiveDefinition(ctx, /* includeVoiceFeatures */ false);
  await runCreate(ctx, fallbackDef);
  ctx.log.success(`Scratch org created (alias "${alias}", ${durationDays} day(s))`);
  return await orgDisplay(alias, { onCommand: (c) => ctx.log.command(c) });
}

async function runCreate(ctx: PhaseContext, definitionFile: string): Promise<void> {
  const { alias, durationDays } = ctx.config.scratchOrg;
  await sf(
    [
      'org',
      'create',
      'scratch',
      '--definition-file',
      definitionFile,
      '--alias',
      alias,
      '--target-dev-hub',
      ctx.config.devHub.alias,
      '--duration-days',
      String(durationDays),
      // Without this, the CLI leaves the previous default in place and later phases that omit
      // --target-org would silently act on the wrong org.
      '--set-default',
      '--wait',
      '20',
    ],
    { timeoutMs: 25 * 60_000, onCommand: (c) => ctx.log.command(c) },
  );
}

/**
 * Merges runtime configuration into the tracked scratch definition and writes the result.
 *
 * The tracked JSON stays clean and valid (the CLI rejects unknown properties, so it cannot carry
 * comments); the knobs live in `config/scv-setup.config.ts`; this function joins them.
 */
/**
 * The scratch org features that Service Cloud Voice with Partner Telephony needs.
 *
 * ALL THREE are required. Their absence does not fail org creation — it fails much later and far
 * more confusingly, when Setup → Salesforce Voice refuses to render and it looks like a broken
 * selector. Listed here so the retry path can strip exactly these and nothing else.
 */
const VOICE_FEATURE_NAMES = ['ServiceCloudVoicePartnerTelephony', 'Scrt2Conversation', 'BYOOTT'];

/** Matches a feature entry with or without its `:<quantity>` suffix. */
function isVoiceFeature(feature: string): boolean {
  const name = feature.split(':')[0];
  return name !== undefined && VOICE_FEATURE_NAMES.includes(name);
}

/** Reads back the Voice features actually present in a generated definition, for logging. */
function readVoiceFeatures(definitionPath: string): string[] {
  const definition = JSON.parse(readFileSync(resolve(process.cwd(), definitionPath), 'utf8')) as {
    features?: string[];
  };
  return (definition.features ?? []).filter(isVoiceFeature);
}

function writeEffectiveDefinition(ctx: PhaseContext, includeVoiceFeatures: boolean): string {
  const sourcePath = resolve(process.cwd(), ctx.config.scratchOrg.definitionFile);
  const definition = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
    features?: string[];
    edition?: string;
    [key: string]: unknown;
  };

  // The CLI validates the definition against a strict allow-list of properties and rejects anything
  // else with `InvalidJsonCasing` — including `$schema`, the very key that gives you autocomplete
  // while editing the file. Keep it in the tracked JSON for the editor's benefit; strip it here.
  // (This is also why the definition cannot carry `//`-style comment keys, and why its commentary
  // lives in config/README-scratch-def.md instead.)
  delete definition['$schema'];

  let features = [...(definition.features ?? [])];
  if (includeVoiceFeatures) {
    // Additive, de-duplicated: config/project-scratch-def.json owns the list, and the optional
    // SCV_VOICE_FEATURES override only tops it up.
    for (const feature of ctx.config.voice.scratchOrgFeatures) {
      if (!features.includes(feature)) features.push(feature);
    }
  } else {
    // The retry path: strip every Voice feature so the org can at least be created.
    features = features.filter((feature) => !isVoiceFeature(feature));
  }
  definition.features = features;

  if (ctx.config.scratchOrg.edition) {
    definition.edition = ctx.config.scratchOrg.edition;
  }

  const outPath = resolve(process.cwd(), GENERATED_DEF);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  return GENERATED_DEF;
}

/**
 * Heuristic for "the Dev Hub is not entitled to a requested feature".
 *
 * Salesforce does not return a distinguishable error code for this — the ScratchOrgInfo record ends
 * up in Error status with an empty ErrorCode and the CLI surfaces a generic message. We therefore
 * match on the known shapes and, importantly, log the assumption when we act on it.
 */
function isLikelyFeatureEntitlementFailure(error: unknown): boolean {
  if (!(error instanceof SfCommandError)) return false;
  const haystack = `${error.errorName ?? ''} ${error.message}`.toLowerCase();

  // Deliberately NARROW. An earlier version also matched any message containing "feature" or
  // "scratchorginfo", which is far too loose: the word "feature" appears in plenty of unrelated CLI
  // errors, and matching it would swallow a genuine failure, strip the Voice features on retry, and
  // hand back an org that silently cannot run Voice. Failing loudly beats that every time.
  //
  // Only the specific opaque shapes Salesforce returns for an unentitled feature qualify. Anything
  // that names its problem — InvalidJsonCasing, auth errors, quota errors — must propagate.
  return (
    haystack.includes('unknown server error') ||
    haystack.includes('an unexpected error occurred') ||
    haystack.includes('not available in this org')
  );
}
