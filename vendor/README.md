# Vendor contact center definition

Put your telephony vendor's contact center definition XML here as `contact-center.xml` (or point
`SCV_CC_DEFINITION_FILE` elsewhere).

## What this file is

The **Setup import format** your vendor ships with their install guide:

```xml
<callCenter>
    <section sortOrder="0" name="reqGeneralInfo" label="General Information">
        <item sortOrder="0" name="reqInternalName" label="InternalName">AcmeContactCenter</item>
        <item sortOrder="1" name="reqDisplayName" label="Display Name">...</item>
        <item sortOrder="2" name="reqVendorInfoApiName" label="Conversation Vendor Info Developer Name">acme__acmeTelephony</item>
    </section>
    ...
</callCenter>
```

Phase 60 reads two values out of it automatically, so you do not configure them twice:

| Item | Used for |
| --- | --- |
| `reqVendorInfoApiName` | Choosing the telephony provider in the wizard. Any namespace prefix (`acme__`) is stripped and matched against `ConversationVendorInfo.DeveloperName`. |
| `reqInternalName` | The idempotency check — re-running the setup will not import a second copy. |

## Why it is uploaded and not deployed

This is **not** the Metadata API `CallCenter` format, which uses `<CallCenter xmlns=...>` with
`<sections>` / `<items>` elements. Converting the vendor file to that format was tried and the
platform rejected it twice — `Element ... sortOrder invalid at this location in type CallCenterItem`,
then `The name "null" is not valid.`

The file is meant to be *imported*, and the import is a file upload in the Setup wizard. There is no
API for it, which is what makes phase 60 the one step in this project that genuinely requires a
browser.

## After import

The imported XML carries the vendor's **placeholder** values — telephony endpoints like
`https://pbx-a.example.com`, `<Presence Status Id>`, an empty telephony integration certificate.
Replace them with your real values before expecting a call to connect. The setup script says as much
in its closing "Manual follow-ups" section rather than pretending the contact center is finished.

## Source control

`vendor/*.xml` is gitignored, with one deliberate exception: `*.example.xml`. A real definition
carries your provider's product names, endpoints, tenant and — once filled in — certificate details,
so it stays out of the repo.

[`contact-center.example.xml`](contact-center.example.xml) is a structurally faithful sample built
entirely from made-up values. It documents the format and is not installable against any real
provider.
