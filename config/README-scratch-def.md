# Why `project-scratch-def.json` looks the way it does

Scratch org definition files are strict JSON — the CLI rejects unknown properties, so the file cannot
carry inline comments. This document is the commentary for it.

## The three Voice features — the important part

```json
"ServiceCloudVoicePartnerTelephony:2",
"Scrt2Conversation",
"BYOOTT:2"
```

**All three are required**, and the `:N` suffix is the number of licences granted to the org — it is
mandatory on the two features that take one.

| Feature | What it provides |
| --- | --- |
| `ServiceCloudVoicePartnerTelephony:N` | The `ServiceCloudVoiceExternalTelephonyPsl` permission set license ("Service Cloud Voice User (Partner Telephony)") and the three `ContactCenter*ExternalTelephony` permission sets. |
| `Scrt2Conversation` | The SCRT2 conversation runtime that Voice calls are carried on. |
| `BYOOTT:N` | The Bring-Your-Own-Third-party-Telephony entitlement itself. |

### The failure mode if you omit them

Org creation **succeeds**. Nothing complains. The problem surfaces much later and looks like something
else entirely: Setup → Salesforce Voice
(`/lightning/setup/ServiceCloudVoicePartnerTelephony/home`) never finishes loading, showing a
permanent spinner behind a *"Sorry to interrupt / CSS Error"* banner. That reads as a broken browser
or a stale Playwright selector, and it is neither.

If the Voice Setup page will not render, check these features first.

### A note on the permission sets

They come from the **feature**, not from enabling Voice. A freshly created org has all three
`ContactCenter*ExternalTelephony` permission sets while the "Turn on Voice with Partner Telephony"
toggle still reads `Disabled`. So their presence proves the org was shaped correctly — it proves
nothing about whether Voice is on. The setup script checks the two things separately for exactly this
reason.

## `$schema`

The file carries a `$schema` key so editors offer completion while you edit it. The CLI **rejects**
it at runtime with `InvalidJsonCasing`, so `src/phases/10-create-org.ts` strips it when generating the
effective definition. Do not remove it from the tracked file; do not pass the tracked file directly to
`sf org create scratch`.

## `edition: "Developer"`

Voice needs the Service Cloud object model (Case, Omni-Channel, Voice Call). `Developer` edition plus
the `ServiceCloud` feature is the cheapest shape that provides it. `Enterprise` also works and is what
you want if you are reproducing a customer org; switch it via `SCV_ORG_EDITION`, which overrides this
file at runtime.

## The other features

| Feature | Why |
| --- | --- |
| `ServiceCloud` | Cases, Entitlements and the Service data model that Voice Calls hang off. |
| `ServiceUser` | Service Cloud user licenses, without which the Voice permission set licenses cannot be assigned to anybody. |
| `LightningServiceConsole` | The Service Console app (`LightningService`). The Voice softphone is a utility bar item in a console app; it does not render in a standard app. |

## `settings.omniChannelSettings.enableOmniChannel`

Omni-Channel is a hard prerequisite: Voice calls are delivered to reps as Omni-Channel work items.
Setting it at org-creation time rather than deploying it afterwards removes a deploy round-trip and a
class of ordering bugs where Voice configuration lands before its router exists.

## Why `ServiceCloudVoiceSettings` is deployed instead of set here

`enableSCVExternalTelephony` is **not** in this file. It is deployed as metadata in phase 20 because a
failure in a scratch definition surfaces as a generic org-creation error, whereas a failure in
`sf project deploy start` surfaces as a named component failure you can act on. The deploy is verified
to work — see the header of `force-app/main/default/settings/ServiceCloudVoice.settings-meta.xml`.

## If your Dev Hub cannot provision these features

Some Dev Hubs are not entitled, and fail org creation with a bare `An unknown server error occurred`
and no error code ([forcedotcom/cli#1495](https://github.com/forcedotcom/cli/issues/1495)). Phase 10
detects that shape of failure, retries with the Voice features stripped, and reports what it assumed.
The org is then created but cannot run Voice until the Dev Hub is entitled.
