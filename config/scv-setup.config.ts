/**
 * Single source of truth for everything tunable in this project.
 *
 * Nothing else in `src/` should contain an org alias, a permission set name, a package id or a
 * timeout. If you find yourself editing a file under `src/phases/` to change a *value*, that value
 * belongs here instead.
 *
 * Every field can be overridden by an environment variable so the same code runs unattended in CI
 * without editing tracked files. See `.env.example`.
 */

import { SETTINGS_BY_ENV } from './settings-schema.js';

/**
 * Defaults come from `config/settings-schema.ts`, not from this file.
 *
 * That schema is also what generates `.env.example` and the configuration UI's form, so a default
 * written there is guaranteed to be the same one the code uses, the docs quote and the UI shows.
 * Passing an explicit `fallback` is only for the handful of settings deliberately kept out of the
 * UI (paths that are part of the project layout rather than user choices).
 */
function schemaDefault(name: string, fallback?: string): string {
  const fromSchema = SETTINGS_BY_ENV.get(name)?.default;
  if (fromSchema !== undefined) return fromSchema;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `No default for ${name}. Add it to config/settings-schema.ts, or pass an explicit fallback.`,
  );
}

/** Reads an env var, falling back to the schema default. Empty strings count as "not set". */
function env(name: string, fallback?: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? schemaDefault(name, fallback) : value.trim();
}

/** Reads a numeric env var. Throws on non-numeric input rather than silently using the default. */
function envInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  const source =
    raw === undefined || raw.trim() === ''
      ? schemaDefault(name, fallback === undefined ? undefined : String(fallback))
      : raw.trim();
  const parsed = Number.parseInt(source, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/** Reads a boolean env var ("true"/"1"/"yes"/"on" are truthy). */
function envBool(name: string, fallback?: boolean): boolean {
  const raw = process.env[name];
  const source =
    raw === undefined || raw.trim() === ''
      ? schemaDefault(name, fallback === undefined ? undefined : String(fallback))
      : raw.trim();
  return ['true', '1', 'yes', 'on'].includes(source.toLowerCase());
}

/** Reads a comma-separated env var into a trimmed, non-empty list. */
function envList(name: string, fallback?: string): string[] {
  return env(name, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export interface ScvSetupConfig {
  devHub: {
    /**
     * Alias (or username) of an authenticated Dev Hub.
     *
     * Authenticate once, interactively, before running this script:
     *   sf org login web --set-default-dev-hub --alias scvhub
     *
     * The script never handles credentials itself — it reuses the CLI's stored auth and derives a
     * browser session from it (see src/session.ts). That is why there is no password anywhere in
     * this repo.
     */
    alias: string;
  };

  scratchOrg: {
    /** Alias the new scratch org is registered under. Also used to name log/artifact files. */
    alias: string;
    /** Lifetime in days. Max is 30; short-lived orgs keep Dev Hub limits healthy. */
    durationDays: number;
    /** Path to the scratch definition. Runtime overrides are merged on top of it. */
    definitionFile: string;
    /**
     * Overrides merged into the definition file at runtime. Use this to reshape the org without
     * editing the tracked JSON (handy for CI matrix runs across editions).
     */
    edition?: string;
    /** Reuse an existing org with this alias instead of creating one, if it is still alive. */
    reuseIfExists: boolean;
  };

  voice: {
    /**
     * OPTIONAL override for the Voice scratch org features.
     *
     * The features themselves live in `config/project-scratch-def.json`, which is the source of
     * truth — that is the file you edit. This setting exists only so a CI job can vary the licence
     * quantities without rewriting the tracked JSON; leave it empty for normal use.
     *
     * When non-empty, these features are ADDED to whatever the definition file lists (de-duplicated).
     *
     * For reference, the definition file must contain all three of:
     *
     *   ServiceCloudVoicePartnerTelephony:<qty>
     *       Provisions the "Service Cloud Voice User (Partner Telephony)" permission set license
     *       (`ServiceCloudVoiceExternalTelephonyPsl`) and creates the ContactCenter*ExternalTelephony
     *       permission sets.
     *
     *   Scrt2Conversation
     *       The SCRT2 conversation runtime that Voice calls are carried on.
     *
     *   BYOOTT:<qty>
     *       The Bring-Your-Own-Third-party-Telephony entitlement itself.
     *
     * The `:<qty>` suffix is the number of licences granted to the org and is REQUIRED on the two
     * features that take one. Omitting all three does not fail org creation — it fails much later
     * and far more confusingly, when Setup → Salesforce Voice does not render.
     */
    scratchOrgFeatures: string[];

    /**
     * Permission set license to assign to the admin/test user.
     *
     * VERIFIED against a live Partner Telephony org — `SELECT DeveloperName FROM PermissionSetLicense`
     * returns `ServiceCloudVoiceExternalTelephonyPsl` with MasterLabel
     * "Service Cloud Voice User (Partner Telephony)". Do not confuse it with `ServiceCloudVoicePsl`
     * ("Service Cloud Voice User"), which is the Amazon Connect / Salesforce-provided-telephony PSL.
     */
    permissionSetLicense: string;

    /**
     * Permission sets granted to the running user.
     *
     * VERIFIED against a live Partner Telephony org — these are the `Name` (API name) values, not the
     * labels shown in Setup:
     *   ContactCenterAdminExternalTelephony      -> "Salesforce Voice Contact Center Admin (Partner Telephony)"
     *   ContactCenterAgentExternalTelephony      -> "Salesforce Voice Contact Center Rep (Partner Telephony)"
     *   ContactCenterSupervisorExternalTelephony -> "Salesforce Voice Contact Center Supervisor (Partner Telephony)"
     *
     * WHERE THEY COME FROM: the `ServiceCloudVoicePartnerTelephony` scratch org FEATURE, not from
     * enabling Voice. They are present in an org whose "Turn on Voice with Partner Telephony" toggle
     * is still off — verified directly. So their existence says the org was shaped correctly and
     * says nothing at all about whether Voice is on; never use them as an enablement probe.
     *
     * If phase 40 reports them missing, the org was created without that feature.
     *
     * Assigning them matters beyond permissions: the Setup page for Partner Telephony contact
     * centers only appears once the running user holds them, which is why phase 60 depends on this
     * phase having run.
     */
    permissionSets: string[];
  };

  package: {
    /**
     * The vendor's Service Cloud Voice managed package to install.
     *
     * Accepts either a package version id (starts with `04t`) or a full AppExchange/packaging install
     * URL, from which the `04t` id is extracted. Leave empty to skip installation entirely — the org
     * is still left in a "ready to install" state, which is the useful default when you want to
     * install by hand.
     */
    versionId: string;
    /** Installation key, if the vendor's package version is protected. */
    installationKey: string;
    /** Minutes to wait for installation. Managed SCV packages are large; 20+ minutes is normal. */
    waitMinutes: number;
    /**
     * `AdminsOnly` grants access to system administrators only (the safe default for a dev org);
     * `AllUsers` grants to every user profile.
     */
    securityType: 'AdminsOnly' | 'AllUsers';
  };

  csp: {
    /**
     * CSP Trusted Sites (Setup → Security → Trusted URLs).
     *
     * Managed packages that load scripts, fonts, media or iframes from their own domains need those
     * domains trusted, or the browser blocks them and the component fails in a way that looks like a
     * broken package rather than a missing setting.
     *
     * Each entry is either `https://example.com` or `My_Name|https://example.com`. Without an
     * explicit name one is derived from the URL. Empty list = phase skipped.
     */
    sites: string[];
    /** Description stored on every site created. */
    description: string;
    /** Which contexts the directives apply to. `All` is the safe default. */
    context: string;
    /**
     * Microphone access, which a softphone needs. Turning this on also makes the phase deploy
     * `SecuritySettings.enablePermissionsPolicy = true`, without which the flag does nothing.
     */
    canAccessMicrophone: boolean;
    canAccessCamera: boolean;
    /**
     * Which CSP directives each site is trusted for. Salesforce requires AT LEAST ONE of these (or
     * camera/microphone) to be true, and rejects a site with everything off.
     */
    connectSrc: boolean;
    fontSrc: boolean;
    frameSrc: boolean;
    imgSrc: boolean;
    mediaSrc: boolean;
    styleSrc: boolean;
  };

  certificate: {
    /**
     * Whether to create a self-signed certificate for the contact center to reference as its
     * public key / telephony integration certificate.
     */
    create: boolean;
    /** Label shown in Setup. */
    label: string;
    /**
     * Unique Name. This exact string is written into the contact center's "Certificate Unique Name"
     * (`certDevName`) item, so the two cannot be configured independently.
     */
    developerName: string;
    /** Key size in bits. Salesforce offers 2048 and 4096. */
    keySize: number;
    /** Whether the private key can be exported. */
    exportablePrivateKey: boolean;
  };

  presence: {
    /**
     * Whether to deploy the Online/Busy presence statuses, their permission set, and wire their ids
     * into the contact center.
     */
    create: boolean;
    /** Label of the status meaning "available for calls". Carries the Phone service channel. */
    readyStatusLabel: string;
    /**
     * Label of the status meaning "not available". Carries NO service channel, which is what makes
     * Salesforce treat it as an Away status.
     */
    notReadyStatusLabel: string;
    /** Permission set granting access to both statuses. Created by this project, then assigned. */
    permissionSetName: string;
  };

  contactCenter: {
    /**
     * Whether to import a contact center after installing the package.
     *
     * Only possible *after* installation: the wizard lists telephony providers from
     * `ConversationVendorInfo` records that ship inside the vendor's managed package, and its New
     * button stays disabled until both Voice is enabled and the package is installed.
     */
    create: boolean;
    /**
     * Developer name of the `ConversationVendorInfo` to select in the wizard, e.g. `acmeTelephony`.
     *
     * Leave empty (recommended) to read it from the XML's `<item name="reqVendorInfoApiName">` value
     * and match it against the org's installed vendor infos. Any namespace prefix is stripped, since
     * the XML carries one (`acme__acmeTelephony`) and the record's DeveloperName does not.
     *
     * Deriving it from the file rather than configuring it separately means the two cannot disagree
     * — and the wizard rejects a mismatched pair outright.
     */
    vendorInfoDeveloperName: string;
    /** Display name for the contact center. Informational; the XML's own value wins on import. */
    displayName: string;
    /**
     * Internal (API) name used for the idempotency check.
     *
     * MUST match the `<item name="reqInternalName">` value in your vendor XML, otherwise the phase
     * will not recognise the contact center it just imported and will try to import it again.
     */
    internalName: string;
    /**
     * Path to the contact center definition XML supplied by your telephony vendor.
     *
     * This is the vendor's **Setup import format** (`<callCenter>` with `<section>` / `<item>`), and
     * it is UPLOADED through the Setup wizard, not deployed. It is deliberately not the Metadata API
     * `CallCenter` format: converting the vendor file to that format was tried and the platform
     * rejected it. Because it is uploaded rather than deployed, this path does NOT need to live
     * inside a package directory.
     *
     * If the file is missing, phase 60 skips and reports a manual step rather than half-creating
     * something.
     */
    definitionFile: string;
  };

  consoleApp: {
    /** Whether to create the console app at all. */
    create: boolean;
    /**
     * API name of the Lightning CONSOLE app to create. The softphone does not render in a standard
     * app, so this is deliberately a console app rather than a reuse of `LightningService`.
     */
    developerName: string;
    /** Label shown in the App Launcher. */
    label: string;
    /**
     * The telephony vendor's utility bar component, e.g. `acme:AcmeVoiceBridge`.
     *
     * VENDOR-SPECIFIC and namespaced: it ships inside the managed package, so this metadata cannot
     * deploy into an org that lacks the package. If the deploy fails complaining about an unknown
     * component, this is almost always the value to check.
     */
    bridgeComponent: string;
    /** Label for the bridge utility item. */
    bridgeLabel: string;
    /**
     * The Setup UI's "Start automatically" checkbox (`eager` in metadata). With it off the bridge
     * only loads once a rep opens the utility, so calls can be missed until they do.
     */
    bridgeStartAutomatically: boolean;
    /** Utility panel size in pixels. */
    bridgeWidth: number;
    bridgeHeight: number;
    /**
     * Permission set granting visibility of the app. Created by this project and assigned to the
     * running user — additive, unlike deploying a Profile.
     */
    accessPermissionSet: string;
  };

  runtime: {
    /** Run the browser visibly. Invaluable when a Setup page changes and a selector breaks. */
    headed: boolean;
    /** Slow each Playwright action down by N ms. Debugging aid; leave at 0 for real runs. */
    slowMoMs: number;
    /** Default timeout for a single UI interaction. Setup pages are slow; be generous. */
    actionTimeoutMs: number;
    /** Timeout for a Setup page to finish loading. Lightning Setup can take 30s+ on a cold org. */
    navigationTimeoutMs: number;
    /** Where screenshots, traces and the run report are written. */
    artifactDir: string;
    /** Capture a screenshot after every UI phase, not just on failure. */
    screenshotEveryPhase: boolean;
  };
}

export const config: ScvSetupConfig = {
  devHub: {
    alias: env('SCV_DEVHUB_ALIAS'),
  },

  scratchOrg: {
    alias: env('SCV_ORG_ALIAS'),
    durationDays: envInt('SCV_ORG_DURATION_DAYS'),
    definitionFile: env('SCV_SCRATCH_DEF', 'config/project-scratch-def.json'),
    edition: process.env['SCV_ORG_EDITION']?.trim() || undefined,
    reuseIfExists: envBool('SCV_REUSE_ORG'),
  },

  voice: {
    // Empty by default: config/project-scratch-def.json owns the feature list. Set a comma-separated
    // SCV_VOICE_FEATURES only to add to or raise the quantities from that file, e.g.
    // "ServiceCloudVoicePartnerTelephony:5,BYOOTT:5".
    scratchOrgFeatures: envList('SCV_VOICE_FEATURES'),
    permissionSetLicense: 'ServiceCloudVoiceExternalTelephonyPsl',
    permissionSets: envList('SCV_PERMISSION_SETS'),
  },

  package: {
    versionId: env('SCV_PACKAGE_VERSION_ID'),
    installationKey: env('SCV_PACKAGE_INSTALL_KEY'),
    waitMinutes: envInt('SCV_PACKAGE_WAIT_MINUTES'),
    securityType: env('SCV_PACKAGE_SECURITY') as 'AdminsOnly' | 'AllUsers',
  },

  csp: {
    sites: envList('SCV_CSP_SITES'),
    description: env('SCV_CSP_DESCRIPTION'),
    context: env('SCV_CSP_CONTEXT'),
    canAccessMicrophone: envBool('SCV_CSP_MICROPHONE'),
    canAccessCamera: envBool('SCV_CSP_CAMERA'),
    connectSrc: envBool('SCV_CSP_CONNECT_SRC'),
    fontSrc: envBool('SCV_CSP_FONT_SRC'),
    frameSrc: envBool('SCV_CSP_FRAME_SRC'),
    imgSrc: envBool('SCV_CSP_IMG_SRC'),
    mediaSrc: envBool('SCV_CSP_MEDIA_SRC'),
    styleSrc: envBool('SCV_CSP_STYLE_SRC'),
  },

  certificate: {
    create: envBool('SCV_CREATE_CERTIFICATE'),
    label: env('SCV_CERT_LABEL'),
    developerName: env('SCV_CERT_NAME'),
    keySize: envInt('SCV_CERT_KEY_SIZE'),
    exportablePrivateKey: envBool('SCV_CERT_EXPORTABLE'),
  },

  presence: {
    create: envBool('SCV_CREATE_PRESENCE_STATUSES'),
    readyStatusLabel: env('SCV_PRESENCE_READY'),
    notReadyStatusLabel: env('SCV_PRESENCE_NOT_READY'),
    permissionSetName: env('SCV_PRESENCE_PERMSET'),
  },

  contactCenter: {
    create: envBool('SCV_CREATE_CONTACT_CENTER'),
    vendorInfoDeveloperName: env('SCV_VENDOR_INFO'),
    displayName: env('SCV_CC_DISPLAY_NAME'),
    internalName: env('SCV_CC_INTERNAL_NAME', 'DevContactCenter'),
    definitionFile: env('SCV_CC_DEFINITION_FILE'),
  },

  consoleApp: {
    create: envBool('SCV_CREATE_CONSOLE_APP'),
    developerName: env('SCV_CONSOLE_APP'),
    label: env('SCV_CONSOLE_APP_LABEL'),
    bridgeComponent: env('SCV_BRIDGE_COMPONENT'),
    bridgeLabel: env('SCV_BRIDGE_LABEL'),
    bridgeStartAutomatically: envBool('SCV_BRIDGE_START_AUTO'),
    bridgeWidth: envInt('SCV_BRIDGE_WIDTH'),
    bridgeHeight: envInt('SCV_BRIDGE_HEIGHT'),
    accessPermissionSet: env('SCV_APP_PERMSET'),
  },

  runtime: {
    headed: envBool('SCV_HEADED'),
    slowMoMs: envInt('SCV_SLOWMO_MS'),
    actionTimeoutMs: envInt('SCV_ACTION_TIMEOUT_MS'),
    navigationTimeoutMs: envInt('SCV_NAV_TIMEOUT_MS'),
    artifactDir: env('SCV_ARTIFACT_DIR'),
    screenshotEveryPhase: envBool('SCV_SCREENSHOT_ALL'),
  },
};
