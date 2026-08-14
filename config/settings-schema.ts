/**
 * The single definition of every configurable setting.
 *
 * ============================================================================================
 * WHY A SCHEMA RATHER THAN JUST CONSTANTS
 * ============================================================================================
 * Three things need to agree about every setting: the typed config the code reads, the
 * `.env.example` a human reads, and the form the configuration UI renders. Written by hand, those
 * three drift — someone adds a setting to the config and forgets the docs, or the UI keeps offering
 * a field that no longer exists.
 *
 * So they are all derived from this one list:
 *
 *   settings-schema.ts ──┬──→ scv-setup.config.ts   (typed values the phases read)
 *                        ├──→ .env.example          (`npm run configure -- --write-env-example`)
 *                        └──→ the configuration UI  (served by tools/config-server.ts)
 *
 * Adding a setting here makes it appear in all three automatically. That is the whole point; please
 * do not shortcut it by adding a bare `process.env` read somewhere in `src/`.
 * ============================================================================================
 */

export type SettingType = 'string' | 'number' | 'boolean' | 'select' | 'list' | 'file';

export interface Setting {
  /** Environment variable name. Also the form field name and the `.env` key. */
  env: string;
  /** Short human label for the UI. */
  label: string;
  /** One-line explanation shown under the field, and as a comment in `.env.example`. */
  description: string;
  type: SettingType;
  /** Default applied when the variable is unset. Always a string, parsed per `type`. */
  default: string;
  /** Group heading in the UI and section header in `.env.example`. */
  group: string;
  /** Allowed values for `select`. */
  options?: string[];
  /**
   * Client- and server-side validation. Returns an error message, or undefined when valid.
   * Kept here so the UI, the `.env` writer and a pre-run check all apply the SAME rule.
   */
  validate?: (value: string) => string | undefined;
  /** Marks values that must never be echoed back to the UI or written to logs. */
  secret?: boolean;
  /** Free-text hint shown as a placeholder. */
  placeholder?: string;
}

/** Validates a Salesforce package version id, accepting a full install URL too. */
export function validatePackageVersionId(value: string): string | undefined {
  if (value.trim() === '') return undefined; // empty is legal: stop at "ready to install"
  if (/04t[a-zA-Z0-9]{12,15}/.test(value)) return undefined;
  return 'Must be an 04t… package version id, or a URL containing one.';
}

function positiveInt(max?: number) {
  return (value: string): string | undefined => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) return 'Must be a whole number of at least 1.';
    if (max !== undefined && parsed > max) return `Must be ${max} or less.`;
    return undefined;
  };
}

function nonEmpty(value: string): string | undefined {
  return value.trim() === '' ? 'Required.' : undefined;
}

/** An API-name-shaped identifier: letters, digits and underscores, not starting with a digit. */
function apiName(value: string): string | undefined {
  if (value.trim() === '') return 'Required.';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
    ? undefined
    : 'Letters, digits and underscores only, and it cannot start with a digit.';
}

export const SETTINGS: Setting[] = [
  /* ---------------------------------------------------------------------------------- Dev Hub */
  {
    env: 'SCV_DEVHUB_ALIAS',
    label: 'Dev Hub alias',
    description:
      'An authenticated Dev Hub. Authenticate once with: sf org login web --set-default-dev-hub --alias scvhub',
    type: 'string',
    default: 'scvhub',
    group: 'Dev Hub',
    validate: nonEmpty,
  },

  /* ---------------------------------------------------------------------------- Scratch org */
  {
    env: 'SCV_ORG_ALIAS',
    label: 'Scratch org alias',
    description: 'Alias the new org is registered under.',
    type: 'string',
    default: 'scv-dev',
    group: 'Scratch org',
    validate: nonEmpty,
  },
  {
    env: 'SCV_ORG_DURATION_DAYS',
    label: 'Lifetime (days)',
    description: 'How long the scratch org lives. Maximum 30.',
    type: 'number',
    default: '7',
    group: 'Scratch org',
    validate: positiveInt(30),
  },
  {
    env: 'SCV_ORG_EDITION',
    label: 'Edition override',
    description: 'Overrides the edition in the scratch definition. Leave empty to use Developer.',
    type: 'select',
    default: '',
    options: ['', 'Developer', 'Enterprise'],
    group: 'Scratch org',
  },
  {
    env: 'SCV_REUSE_ORG',
    label: 'Reuse existing org',
    description: 'Reuse an org with the same alias if it is still alive, instead of creating one.',
    type: 'boolean',
    default: 'true',
    group: 'Scratch org',
  },
  {
    env: 'SCV_VOICE_FEATURES',
    label: 'Extra Voice features',
    description:
      'Optional top-up for the features in config/project-scratch-def.json, e.g. to raise licence counts. Normally empty.',
    type: 'list',
    default: '',
    group: 'Scratch org',
    placeholder: 'ServiceCloudVoicePartnerTelephony:5,BYOOTT:5',
  },

  /* ------------------------------------------------------------------------------ Permissions */
  {
    env: 'SCV_PERMISSION_SETS',
    label: 'Permission sets',
    description:
      'Assigned to the running user. The first three come from the Voice feature; the last two are the BYO-channel set and the presence-status set this project deploys.',
    type: 'list',
    default: [
      'ContactCenterAdminExternalTelephony',
      'ContactCenterAgentExternalTelephony',
      'ContactCenterSupervisorExternalTelephony',
      'ContactCenterBringYourOwnChannelUser',
      'Service_Presence_Statuses_Access',
    ].join(','),
    group: 'Permissions',
  },

  /* ------------------------------------------------------------------------ CSP trusted sites */
  {
    env: 'SCV_CSP_SITES',
    label: 'Trusted URLs',
    description:
      'Domains your package loads from, comma-separated. Use "Name|https://url" to choose the API name. Leave empty to skip. Without these, the browser blocks the package and it looks broken rather than unconfigured.',
    type: 'list',
    default: '',
    group: 'CSP trusted sites',
    placeholder: 'https://pbx-a.example.com,https://pbx-b.example.com',
    validate: (value) => {
      if (value.trim() === '') return undefined;
      for (const entry of value.split(',')) {
        const raw = entry.includes('|') ? entry.slice(entry.indexOf('|') + 1) : entry;
        const url = raw.trim();
        if (url === '') continue;
        if (!/^(https|wss):\/\/[^\s]+$/i.test(url)) {
          return `"${url}" must be an https:// or wss:// URL including the scheme.`;
        }
      }
      return undefined;
    },
  },
  {
    env: 'SCV_CSP_DESCRIPTION',
    label: 'Description',
    description: 'Stored on every site created, so their origin is obvious in Setup.',
    type: 'string',
    default: 'Added by the SCV org setup script',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_CONTEXT',
    label: 'Context',
    description: 'Which contexts the directives apply to.',
    type: 'select',
    default: 'All',
    options: ['All', 'LEX', 'Communities', 'VisualForce'],
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_MICROPHONE',
    label: 'Allow microphone',
    description:
      'A softphone needs this. Enabling it also deploys SecuritySettings.enablePermissionsPolicy, without which the flag does nothing.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_CAMERA',
    label: 'Allow camera',
    description: 'Only needed for video. Also requires the permissions policy.',
    type: 'boolean',
    default: 'false',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_CONNECT_SRC',
    label: 'connect-src',
    description: 'Script interface loads (XHR, WebSocket). Needed by most telephony connectors.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_FRAME_SRC',
    label: 'frame-src',
    description: 'iframe loads. Needed when the vendor embeds its own UI.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_IMG_SRC',
    label: 'img-src',
    description: 'Image loads.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_STYLE_SRC',
    label: 'style-src',
    description: 'Stylesheet loads.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_FONT_SRC',
    label: 'font-src',
    description: 'Font loads.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },
  {
    env: 'SCV_CSP_MEDIA_SRC',
    label: 'media-src',
    description: 'Audio and video loads. Relevant for call recordings and ringtones.',
    type: 'boolean',
    default: 'true',
    group: 'CSP trusted sites',
  },

  /* ----------------------------------------------------------------------------- Certificate */
  {
    env: 'SCV_CREATE_CERTIFICATE',
    label: 'Create certificate',
    description:
      'Generate a self-signed certificate in the org for the contact center to reference as its public key.',
    type: 'boolean',
    default: 'true',
    group: 'Certificate',
  },
  {
    env: 'SCV_CERT_LABEL',
    label: 'Certificate label',
    description: 'Shown in Setup.',
    type: 'string',
    default: 'Certificate_SF',
    group: 'Certificate',
    validate: nonEmpty,
  },
  {
    env: 'SCV_CERT_NAME',
    label: 'Certificate unique name',
    description:
      'Written into the contact center as "Certificate Unique Name" (certDevName). The two cannot differ.',
    type: 'string',
    default: 'Certificate_SF',
    group: 'Certificate',
    validate: apiName,
  },
  {
    env: 'SCV_CERT_KEY_SIZE',
    label: 'Key size',
    description: 'Certificate key size in bits.',
    type: 'select',
    default: '2048',
    options: ['2048', '4096'],
    group: 'Certificate',
  },
  {
    env: 'SCV_CERT_EXPORTABLE',
    label: 'Exportable private key',
    description: 'Whether the private key can be exported from the org.',
    type: 'boolean',
    default: 'true',
    group: 'Certificate',
  },

  /* ------------------------------------------------------------------------ Presence statuses */
  {
    env: 'SCV_CREATE_PRESENCE_STATUSES',
    label: 'Create presence statuses',
    description:
      'Deploy the Online and Busy statuses and wire their ids into the contact center. Without a status a rep cannot go available.',
    type: 'boolean',
    default: 'true',
    group: 'Presence statuses',
  },
  {
    env: 'SCV_PRESENCE_READY',
    label: 'Ready status label',
    description: 'The status meaning "available for calls". Carries the Phone service channel.',
    type: 'string',
    default: 'Online',
    group: 'Presence statuses',
    validate: nonEmpty,
  },
  {
    env: 'SCV_PRESENCE_NOT_READY',
    label: 'Not-ready status label',
    description:
      'The status meaning "not available". Carries no channel, which is what makes Salesforce treat it as Away.',
    type: 'string',
    default: 'Busy',
    group: 'Presence statuses',
    validate: nonEmpty,
  },
  {
    env: 'SCV_PRESENCE_PERMSET',
    label: 'Presence permission set',
    description: 'Permission set granting both statuses. Deployed by this project, then assigned.',
    type: 'string',
    default: 'Service_Presence_Statuses_Access',
    group: 'Presence statuses',
    validate: apiName,
  },

  /* --------------------------------------------------------------------------- Vendor package */
  {
    env: 'SCV_PACKAGE_VERSION_ID',
    label: 'Package version id',
    description:
      'The vendor package to install. An 04t… id or an install URL containing one. Leave empty to stop at "ready to install".',
    type: 'string',
    default: '',
    group: 'Vendor package',
    validate: validatePackageVersionId,
    placeholder: '04t000000000000AAA',
  },
  {
    env: 'SCV_PACKAGE_INSTALL_KEY',
    label: 'Installation key',
    description: 'Only if the vendor protected the package version.',
    type: 'string',
    default: '',
    group: 'Vendor package',
    secret: true,
  },
  {
    env: 'SCV_PACKAGE_WAIT_MINUTES',
    label: 'Install timeout (minutes)',
    description: 'Managed SCV packages are large; installs of 20+ minutes are normal.',
    type: 'number',
    default: '30',
    group: 'Vendor package',
    validate: positiveInt(120),
  },
  {
    env: 'SCV_PACKAGE_SECURITY',
    label: 'Access',
    description: 'Which profiles get access on install.',
    type: 'select',
    default: 'AdminsOnly',
    options: ['AdminsOnly', 'AllUsers'],
    group: 'Vendor package',
  },

  /* ---------------------------------------------------------------------------- Contact centre */
  {
    env: 'SCV_CREATE_CONTACT_CENTER',
    label: 'Import contact center',
    description: 'Import the vendor XML through the Setup wizard after the package is installed.',
    type: 'boolean',
    default: 'true',
    group: 'Contact center',
  },
  {
    env: 'SCV_CC_DEFINITION_FILE',
    label: 'Vendor XML',
    description:
      'The vendor\'s contact center definition. The provider and internal name are read out of this file.',
    type: 'file',
    default: 'vendor/contact-center.xml',
    group: 'Contact center',
  },
  {
    env: 'SCV_VENDOR_INFO',
    label: 'Vendor override',
    description:
      'ConversationVendorInfo developer name. Leave empty to read it from the XML, which is safer.',
    type: 'string',
    default: '',
    group: 'Contact center',
    placeholder: 'acmeTelephony',
  },
  {
    env: 'SCV_CC_INTERNAL_NAME',
    label: 'Internal name override',
    description:
      'Leave empty to read reqInternalName from the XML. Setting it wrong makes every run re-import.',
    type: 'string',
    default: '',
    group: 'Contact center',
  },
  {
    env: 'SCV_CC_DISPLAY_NAME',
    label: 'Display name',
    description: 'Informational only; the XML\'s own value wins on import.',
    type: 'string',
    default: 'Dev Contact Center',
    group: 'Contact center',
  },

  /* ----------------------------------------------------------------------------- Console app */
  {
    env: 'SCV_CREATE_CONSOLE_APP',
    label: 'Create console app',
    description:
      'Deploy a Lightning console app whose utility bar carries the vendor bridge and Omni-Channel.',
    type: 'boolean',
    default: 'true',
    group: 'Console app',
  },
  {
    env: 'SCV_CONSOLE_APP',
    label: 'App API name',
    description: 'API name of the console app. The softphone does not render in a standard app.',
    type: 'string',
    default: 'SCV',
    group: 'Console app',
    validate: apiName,
  },
  {
    env: 'SCV_CONSOLE_APP_LABEL',
    label: 'App label',
    description: 'Shown in the App Launcher.',
    type: 'string',
    default: 'SCV',
    group: 'Console app',
    validate: nonEmpty,
  },
  {
    env: 'SCV_BRIDGE_COMPONENT',
    label: 'Vendor bridge component',
    description:
      "Your telephony vendor's utility bar component, namespace included. It ships inside their managed package, so the app cannot deploy without it installed. Leave empty to skip the console app phase.",
    type: 'string',
    default: '',
    group: 'Console app',
    placeholder: 'acme:AcmeVoiceBridge',
  },
  {
    env: 'SCV_BRIDGE_LABEL',
    label: 'Bridge label',
    description: 'Label for the bridge utility item, as a rep sees it in the utility bar.',
    type: 'string',
    default: 'Softphone',
    group: 'Console app',
    validate: nonEmpty,
  },
  {
    env: 'SCV_BRIDGE_START_AUTO',
    label: 'Start automatically',
    description:
      'The "Start automatically" checkbox. With it off the bridge loads only when a rep opens the utility, so calls can be missed until they do.',
    type: 'boolean',
    default: 'true',
    group: 'Console app',
  },
  {
    env: 'SCV_BRIDGE_WIDTH',
    label: 'Bridge width (px)',
    description: 'Utility panel width.',
    type: 'number',
    default: '340',
    group: 'Console app',
    validate: positiveInt(2000),
  },
  {
    env: 'SCV_BRIDGE_HEIGHT',
    label: 'Bridge height (px)',
    description: 'Utility panel height.',
    type: 'number',
    default: '480',
    group: 'Console app',
    validate: positiveInt(2000),
  },
  {
    env: 'SCV_APP_PERMSET',
    label: 'App access permission set',
    description:
      'Permission set granting visibility of the app, created and assigned by this project. Additive, unlike deploying a Profile.',
    type: 'string',
    default: 'SCV_App_Access',
    group: 'Console app',
    validate: apiName,
  },

  /* --------------------------------------------------------------------------------- Runtime */
  {
    env: 'SCV_HEADED',
    label: 'Visible browser',
    description: 'Run the browser visibly. The fastest way to debug a broken Setup selector.',
    type: 'boolean',
    default: 'false',
    group: 'Runtime',
  },
  {
    env: 'SCV_SLOWMO_MS',
    label: 'Slow motion (ms)',
    description: 'Delay each browser action. Debugging aid; 0 for real runs.',
    type: 'number',
    default: '0',
    group: 'Runtime',
  },
  {
    env: 'SCV_ACTION_TIMEOUT_MS',
    label: 'Action timeout (ms)',
    description: 'Per-interaction timeout. Setup pages are slow.',
    type: 'number',
    default: '30000',
    group: 'Runtime',
  },
  {
    env: 'SCV_NAV_TIMEOUT_MS',
    label: 'Navigation timeout (ms)',
    description: 'Page-load timeout. Lightning Setup can take 30s+ on a cold org.',
    type: 'number',
    default: '90000',
    group: 'Runtime',
  },
  {
    env: 'SCV_ARTIFACT_DIR',
    label: 'Artifact directory',
    description: 'Where screenshots are written.',
    type: 'string',
    default: 'artifacts',
    group: 'Runtime',
  },
  {
    env: 'SCV_SCREENSHOT_ALL',
    label: 'Screenshot every UI phase',
    description: 'Not only on failure.',
    type: 'boolean',
    default: 'true',
    group: 'Runtime',
  },
];

/** Lookup by environment variable name. */
export const SETTINGS_BY_ENV = new Map(SETTINGS.map((setting) => [setting.env, setting]));

/** Ordered list of group names, as first encountered. */
export function settingGroups(): string[] {
  const groups: string[] = [];
  for (const setting of SETTINGS) if (!groups.includes(setting.group)) groups.push(setting.group);
  return groups;
}

/** Runs every validator over a set of values. Returns { env: message } for the failures. */
export function validateAll(values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const setting of SETTINGS) {
    const value = values[setting.env] ?? setting.default;
    const error = setting.validate?.(value);
    if (error) errors[setting.env] = error;
  }
  return errors;
}
