# Salesforce Voice Starter

Prepares a Salesforce scratch org with everything a **Salesforce Voice** — formerly Service Cloud
Voice (SCV) — **Partner Telephony / BYOT** managed package needs, installs that package, and
completes the post-install configuration.

It is vendor-agnostic: point it at any partner telephony package and its contact center definition.

It is CLI-first and browser-second: everything that has a supported `sf` command or a deployable
metadata type is done that way, and Playwright is used only for the handful of steps that genuinely
have no API. Each of those steps carries a comment explaining why it is in the browser, so that when
Salesforce adds API coverage you know exactly what to delete.

---

## Quick start

```bash
# 1. Authenticate a Dev Hub (once, interactively — this script never handles credentials)
sf org login web --set-default-dev-hub --alias scvhub

# 2. Install dependencies (also downloads the Chromium build Playwright uses)
npm install

# 3. (optional) point at your provider's contact center definition XML, which ships with
#    their install guide. Anything under vendor/ is gitignored, so it is a safe place to
#    keep it. Leave SCV_CC_DEFINITION_FILE empty to skip the contact center phases.
export SCV_CC_DEFINITION_FILE=vendor/contact-center.xml

# 4. Configure and run — either through the local UI...
npm run configure         # form with validation, profiles, and live run output

# ...or entirely from the terminal
cp .env.example .env      # then edit; at minimum set SCV_DEVHUB_ALIAS
npm run setup
```

Without `SCV_PACKAGE_VERSION_ID` the run stops in the "ready to install a SCV package" state — a
perfectly good way to use this. Set it (an `04t…` id or an install URL) to have the script install the
vendor package and import the contact center as well.

A full clean run takes about six minutes: scratch org → Voice → permissions → package → contact
center → verification.

---

## Usage

```bash
npm run setup                            # everything
npm run setup -- --headed                # visible browser (how you debug a broken selector)
npm run setup -- --list                  # list phases
npm run setup -- --only=enable-voice     # one phase
npm run setup -- --skip=install-package
npm run setup -- --org=existing-alias    # operate on an org you already have
npm run setup -- --no-reuse              # force a brand new scratch org
npm run setup -- --delete                # delete the scratch org

npm run verify                           # readiness checks only
npm test                                 # the same checks as Playwright tests, plus a UI smoke test
npm run typecheck
```

Phase names for `--only` and `--skip` are listed by `--list`, and explained in
[What it does](#what-it-does) below.

Artifacts (screenshots per UI phase, plus a screenshot on failure) land in `artifacts/`.

---

## Configuration

```bash
npm run configure          # form with validation, saved profiles, and live run output
```

Opens a local page on `127.0.0.1:4747` that renders every setting, validates it, writes `.env`, and
can launch the run while streaming its output. Beyond convenience it buys three things:

- **Validation before a six-minute run.** A malformed `04t` id, a missing vendor XML, or an internal
  name that disagrees with the XML about to be imported are all caught in milliseconds instead of
  minutes in.
- **Named profiles** (`config/profiles.json`, gitignored) — "provider A", "provider B latest" — so
  switching vendor or package version is one click. Secrets are deliberately never written to a
  profile.
- **Live progress**, with the closing manual follow-ups readable in the page rather than scrollback.

### One schema, three consumers

Every setting is defined once, in [`config/settings-schema.ts`](config/settings-schema.ts):

```text
settings-schema.ts ──┬──→ config/scv-setup.config.ts   (typed values the phases read)
                     ├──→ .env.example                 (npm run env-example)
                     └──→ the configuration UI form    (generated at request time)
```

A default written in the schema is therefore guaranteed to be the one the code uses, the one the docs
quote, and the one the form shows. Adding a setting makes it appear in all three. **Do not** add a
bare `process.env` read in `src/` — it defeats the whole arrangement.

`.env.example` is generated; edit the schema, not the file.

If you prefer files to forms, everything still works by editing `.env` by hand.

The scratch org shape is [`config/project-scratch-def.json`](config/project-scratch-def.json), with
its commentary in [`config/README-scratch-def.md`](config/README-scratch-def.md) (the CLI rejects
unknown properties, so the JSON cannot carry comments of its own).

### If your Dev Hub cannot provision the Voice features

Some Dev Hubs are not entitled, and fail org creation with a bare `An unknown server error occurred`
and no error code ([forcedotcom/cli#1495](https://github.com/forcedotcom/cli/issues/1495)). Phase 10
detects that shape of failure, retries with the three Voice features stripped, and reports what it
assumed — so you get an org rather than a dead run, along with a clear note that it cannot run Voice
yet. The Dev Hub used to build this was entitled, so the fallback stays dormant.

---

## What it does

| Phase | Name | How | Why that way |
| --- | --- | --- | --- |
| 00 | `preflight` | CLI | Fails fast on a missing CLI or an unusable Dev Hub session, with the exact command to fix it. |
| 10 | `create-org` | CLI | `sf org create scratch`. Reuses an existing org with the same alias by default. |
| 20 | `deploy-settings` | Metadata | Settings, the Online/Busy presence statuses, and the permission set granting them. **This is what actually enables Voice.** |
| 22 | `csp-trusted-sites` | Metadata | Trusted URLs the vendor package loads from, plus the permissions policy that microphone access needs. Skipped when none are configured. |
| 24 | `remote-sites` | Metadata | Remote Site Settings the org calls out to. Always adds the org's own SCRT2 endpoint, derived from its instance URL. |
| 25 | `certificate` | **Browser** | Generates the self-signed certificate the contact center references as its public key. |
| 30 | `enable-voice` | CLI, **browser only on failure** | Verifies Voice is really on; repairs via the Setup toggle if the deploy did not take. |
| 40 | `permissions` | CLI | Assigns the Voice permission set license and five permission sets. |
| 50 | `install-package` | CLI | `sf package install`. Skipped when no package id is set. |
| 55 | `render-contact-center` | Local | Substitutes the certificate name, the certificate PEM (the UI's **Public Key** field) and the presence status ids into a copy of the vendor XML. |
| 60 | `contact-center` | **Browser** | Imports that rendered XML through the Setup wizard. |
| 65 | `contact-center-users` | CLI | Adds the user to the contact center by setting `User.CallCenterId`. |
| 70 | `console-app` | Metadata | Deploys a Lightning **console** app whose utility bar carries the vendor bridge (start automatically) and Omni-Channel, plus a permission set making it visible. Skipped when no bridge component is set, since that value is vendor-specific and has no default. |
| 80 | `verify` | CLI | Independent readiness checks. This is what makes a green run mean something. |

Every phase is **idempotent** — re-running against a half-configured org converges rather than
failing. That matters because the interesting failures happen in phase 50 or later, and recreating
the org each time to retry burns Dev Hub limits.

---

## Why the browser is used at all

**Honest answer: for org preparation, it mostly isn't.** Enabling Voice is a metadata deploy, and it
works. Verified on a fresh scratch org: `enableSCVExternalTelephony` read `false`,
`sf project deploy start` reported success, a subsequent retrieve read `true` — no browser involved.
A full `npm run setup` completes without launching Chromium at all.

Playwright earns its place in three narrower ways:

1. **Importing the contact center** (phase 60) — the one step with genuinely no API. Vendors ship
   their definition in the Setup **import** format (`<callCenter>` with `<section>`/`<item>`), which
   is *not* the Metadata API `CallCenter` format. Converting between them was tried and the platform
   rejected it twice (`sortOrder invalid at this location in type CallCenterItem`, then
   `The name "null" is not valid.`). The file is meant to be uploaded through the wizard, so that is
   what the script does.
2. **A repair path** for enablement (phase 30). If the deploy ever silently fails to take, the script
   flips the Setup toggle rather than leaving you with a half-configured org.
3. **Verification that survives a redesign.** `npm test` asserts the Setup page still renders and the
   toggle is still findable — so when the fallback is finally needed, it is known to work.

### The contact center import flow, and why its order is not arbitrary

Every step here was established against a live org, and each one has a precondition that produces a
confusing failure if you get it wrong:

| Step | Precondition / gotcha |
| --- | --- |
| Setup node `ServiceCloudVoicePartnerTelephonyContactCenters` | Not `CallCenters` — that is the legacy CTI page with a "Say Hello to Salesforce Call Center" splash. This page appears only once the **Partner Telephony permission set is assigned to the running user**, which is why phase 60 depends on phase 40, not merely on phase 50. |
| Click **New** | Disabled until Voice is enabled **and** the vendor package is installed. |
| Select the telephony provider **first** | Uploading before selecting fails with *"The vendor name in the XML file must match the name of the vendor that you selected."* |
| **Next**, then upload on step 2 | The file input lives on step 2, not step 1. |
| Wizard closes itself | The dialog disappearing **is** the success signal — there is no Save button to click. The script then confirms with a `CallCenter` query rather than trusting the UI. |

The provider and the internal name are both read out of the XML (`reqVendorInfoApiName`,
`reqInternalName`), so they cannot drift from the file being imported.

### CSP trusted sites

Managed packages routinely load scripts, fonts, media or iframes from their own domains. Without a
matching **Trusted URL** the browser's Content Security Policy blocks them, and the failure presents
as a broken package rather than a missing org setting — expensive to debug, cheap to configure.

Add the domains in the configuration UI's **CSP trusted sites** section (or `SCV_CSP_SITES`), one per
entry, either `https://example.com` or `My_Name|https://example.com` when you want to choose the API
name. The phase is skipped entirely when the list is empty.

One non-obvious dependency: `canAccessMicrophone` — which a softphone needs — does nothing on its own.
It also requires `SecuritySettings.enablePermissionsPolicy`, which defaults to `false`. The phase
deploys that flag automatically whenever microphone or camera access is requested, so the setting
cannot be silently ineffective.

Salesforce rejects a site with every directive switched off, so at least one of connect/font/frame/
img/media/style or camera/microphone must stay on.

### Remote site settings, and the SCRT2 endpoint you would otherwise forget

Trusted URLs above are the *browser* side allow list. Remote Site Settings are the *server* side one:
anything the org itself calls out to — Apex callouts, a vendor's REST API — is refused unless its host
is listed, and the error names the URL but not the setting that blocked it. A telephony package
normally needs entries in both lists, and they are rarely the same hosts, so they are configured
separately (**Remote site settings** in the UI, or `SCV_REMOTE_SITES`).

One entry cannot be configured ahead of time. Service Cloud Voice carries calls over SCRT2, reachable
at the org's own My Domain with `.my.salesforce.com` replaced by `.my.salesforce-scrt.com`:

    https://no-software-1234.scratch.my.salesforce.com
      -> https://no-software-1234.scratch.my.salesforce-scrt.com

Every org — so every scratch org this script creates — has a different one, which is exactly why it
is the entry most often missing. The phase derives it from the org's instance URL and adds it as
`Salesforce_SCRT2`, on a fresh org and on an existing one (`--org=<alias>`) alike. Nothing to
configure; `SCV_REMOTE_SITE_ADD_SCRT=false` turns it off. If the instance URL is not a My Domain URL
the phase warns and skips that entry rather than inventing a host that does not exist.

Two platform limits worth knowing, both verified against a live org: a RemoteSiteSetting API name is
capped at **40** characters (half what a trusted site allows, so long URLs get truncated names — use
the `Name|https://url` form to choose your own), and the org rejects two remote sites carrying the
same URL. A hand-configured entry duplicating the SCRT2 endpoint is therefore dropped in favour of
the automatic one.

### The trap that makes phase 30 worth reading

The obvious enablement check is wrong. The three `ContactCenter*ExternalTelephony` permission sets and
the `ServiceCloudVoiceExternalTelephonyPsl` license look like a perfect proxy for "Voice is on" — but
they are created by the **scratch org features**, not by enablement. An org with the toggle firmly
off has all of them. Verified directly: a fresh org had all three permission sets while
"Turn on Voice with Partner Telephony" read `Disabled`.

The only trustworthy signal is `enableSCVExternalTelephony` itself, which is what the script reads.
The permission sets are checked separately, because *their* absence means something different — a
missing scratch org feature.

### How Playwright authenticates

It does not automate the login form. That would mean storing a password, would break under MFA, and
would not run in CI. Instead `src/session.ts` takes the access token the CLI already holds
(`sf org display`) and POSTs it to `/secur/frontdoor.jsp` to exchange it for browser cookies.

No credentials exist anywhere in this repo. The token is sent in a POST body rather than a URL so it
stays out of browser history and referrer headers, and `src/sf.ts` redacts token-shaped strings from
logged command lines.

Two non-obvious things this had to handle, both hit against real orgs:

- The form submit must be **awaited to completion**. Submitting and merely waiting on a load state
  returns while the page is still on `blank.html`, and the next `goto` then dies with
  `net::ERR_ABORTED`.
- `frontdoor.jsp` is not the last hop — it can bounce through `/secur/contentDoor` on a
  `*.file.force.com` domain. Navigating during that chain fails with *"interrupted by another
  navigation"*. `gotoSetup()` retries on both spellings.

A third, unrelated but equally load-bearing: `src/sf.ts` forces `FORCE_COLOR=0` on every `sf` child
process. The CLI colorizes its JSON output when `FORCE_COLOR` is set, producing JSON peppered with
ANSI escapes that does not parse — and the Playwright test runner sets `FORCE_COLOR=1` for its
children, as do many CI providers.

---

## Verified API names

These were read from a live Partner Telephony org rather than taken from documentation, because the
help site shows display names and the API names differ.

| Thing | API name | Display name |
| --- | --- | --- |
| Permission set license | `ServiceCloudVoiceExternalTelephonyPsl` | Service Cloud Voice User (Partner Telephony) |
| Permission set | `ContactCenterAdminExternalTelephony` | Salesforce Voice Contact Center Admin (Partner Telephony) |
| Permission set | `ContactCenterAgentExternalTelephony` | Salesforce Voice Contact Center Rep (Partner Telephony) |
| Permission set | `ContactCenterSupervisorExternalTelephony` | Salesforce Voice Contact Center Supervisor (Partner Telephony) |

Do not confuse `ServiceCloudVoiceExternalTelephonyPsl` with `ServiceCloudVoicePsl` — the latter is
the Amazon Connect / Salesforce-provided-telephony license.

These permission sets come from the **scratch org features**, not from enabling Voice. If phase 40
reports them missing, the org was created without `ServiceCloudVoicePartnerTelephony` — it does not
mean the API name is wrong, and it does not mean Voice is off.

### The three scratch org features

All three are required, and the `:N` suffix is a licence count that must be present:

```json
"ServiceCloudVoicePartnerTelephony:2",
"Scrt2Conversation",
"BYOOTT:2"
```

Omitting them does **not** fail org creation. It fails much later and far more confusingly: Setup →
Salesforce Voice never renders, and Lightning expresses that not as a 404 but as a permanent loading
spinner behind a *"Sorry to interrupt / CSS Error"* banner — which looks exactly like a broken
browser or a rotted selector. If that page stops rendering, check the features before anything else.

### The Setup node

The Voice setup assistant lives at:

```text
/lightning/setup/ServiceCloudVoicePartnerTelephony/home
```

Not `VoiceSettings` — that node does not exist and produces the same misleading "CSS Error" hang.

The toggle on that page is `input[name="toggle-scv"]`. It is anchored by the `name` attribute because
its `id` is generated per render and it exposes **no accessible name** — the page has five
visually-identical unlabelled switches, and only `name` tells them apart. Clicking the `<input>`
directly fails: an SLDS label span overlays it and intercepts pointer events, so the code clicks the
associated `<label>` instead.

Setup renders fine **headless**, on the standard bundled Chromium.

---

## Ordering constraints that are not negotiable

- **Voice before permissions** (30 → 40): the permission sets are created *by* enablement.
- **Package before contact center** (50 → 60): a Partner Telephony contact center is built from a
  `ConversationVendorInfo` record that ships *inside* the vendor's managed package. Before
  installation the vendor picker in the wizard is empty. This is why a script cannot create the
  contact center as part of "preparing the org" — it is inherently post-install.

---

## Maintaining the UI steps

Salesforce redesigns Setup on its own schedule, so selectors will break. The project is arranged so
the fix is local:

- **Every selector lives in [`src/ui/selectors.ts`](src/ui/selectors.ts).** No selector strings appear
  anywhere else.
- Locators are role- and label-based, with `.or()` fallbacks, because Salesforce ships the same
  control as a `lightning-input`, a `lightning-toggle` or a plain checkbox depending on the page's
  vintage — and renamed the product from "Service Cloud Voice" to "Salesforce Voice", so label text
  varies by release too.
- Navigation goes straight to `/lightning/setup/<node>/home` rather than driving the Setup search box,
  which is one of the flakiest controls in the product.

To debug: `SCV_HEADED=true SCV_SLOWMO_MS=250 npm run setup -- --only=enable-voice`

---

## Verification status

Be clear about what has been proven against a live org and what has not.

| Area | Status |
| --- | --- |
| Org creation with all three Voice features | **Verified** — created repeatedly on a live Dev Hub |
| Omni-Channel, settings deploy, Voice enablement | **Verified** — `enableSCVExternalTelephony` false → true via deploy |
| PSL + permission set assignment, and re-running it | **Verified**, including the duplicate-assignment path |
| Console app detection | **Verified**, including the `AppMenuItem.Name` filter trap |
| `verify` phase and `npm test` | **Verified** — all passing |
| Voice Setup page + toggle selector | **Verified** — `input[name="toggle-scv"]`, label-click required |
| `install-package` (phase 50) | **Verified** — installed a real managed package (`04t…`) |
| `contact-center` import (phase 60) | **Verified** — imported a real vendor XML, `CallCenter` row confirmed by query |
| Full clean run, org → contact center | **Verified** — ~6 minutes end to end |
| Full idempotent re-run | **Verified** — every phase no-ops correctly, including install and import |
| Certificate generation (phase 25) | **Verified** — created with the correct unique name |
| Contact center Public Key + cert name + status ids | **Verified in the org** — all four fields populated on the imported contact center |
| Presence statuses + permission set (phase 20) | **Verified** — both deployed, real ids returned |
| XML substitution (phase 55) | **Verified locally** against the real vendor file: exactly 3 lines change |
| Contact center user (phase 65) | **Verified** — `User.CallCenterId` set and read back |
| Configuration UI | **Verified** — form renders from the schema, validation and SSE run streaming both work |
| Console app + utility bar (phase 70) | **Verified** — deployed app is byte-identical to a hand-built one, and the namespace-strip trap is caught |
| CSP trusted sites (phase 22) | **Verified** — 3 sites deployed and read back, `enablePermissionsPolicy` flipped to true |
| Remote site settings (phase 24) | **Verified** — SCRT2 endpoint derived from the org URL, deployed and read back as `RemoteProxy`; re-run updates rather than duplicates. The derivation also reproduces the SCRT2 host of a live sandbox exactly |
| Terms-of-service dialog handling | **Unobserved** — no dialog appeared on a Developer-edition org |
| Phases 55→60→65 together | **Verified** — imported into a live org, all four fields confirmed on the Setup page |
| Phases 25→30→40→55→60→65 from a fresh org | **Not yet** — every phase verified, but not in one run from `create-org` |

Everything except a single run starting from `create-org` has been verified against live orgs. To
close that last gap:

```bash
npm run setup -- --delete
SCV_PACKAGE_VERSION_ID=<04t…> npm run setup -- --no-reuse
```

## What this script deliberately does not do

- **Configure the telephony provider.** Endpoints, API keys and the provider's **public key** are
  vendor-specific and secret. The public key is not needed to *create* a contact center but is
  required before any call can be made or received — the run reports this as a manual follow-up
  rather than pretending the contact center is finished.
- **Amazon Connect.** That is a different setup path (AWS account linkage, tax registration number,
  CloudFormation) and is out of scope. The Amazon flag `enableServiceCloudVoice` is deliberately left
  untouched.

---

## References

- [Set Up Salesforce Voice](https://help.salesforce.com/s/articleView?id=service.voice_setup.htm&type=5)
- [Set Up Salesforce Voice with Partner Telephony](https://help.salesforce.com/s/articleView?id=sf.voice_pt_setup.htm&language=en_US&type=5)
- [Scratch orgs for Partner Telephony](https://developer.salesforce.com/docs/atlas.en-us.voice_pt_developer_guide.meta/voice_pt_developer_guide/voice_pt_scratch_org.htm)
- [`ServiceCloudVoiceSettings` metadata](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_servicecloudvoicesettings.htm)
- [`CallCenter` metadata](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_callcenter.htm)
- [Partner Telephony quickstart (Salesforce)](https://github.com/salesforce/scv-partner-telephony-quickstart)

---

## License

[MIT](LICENSE) © Alberto Zanatta. Fork it freely — the licence asks only that the copyright notice
travels with it.

Not affiliated with or endorsed by Salesforce. "Salesforce", "Service Cloud Voice" and related marks
belong to Salesforce, Inc.
