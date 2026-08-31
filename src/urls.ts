/**
 * URL helpers shared by the metadata phases.
 *
 * Two unrelated phases (CSP trusted sites, remote site settings) need to turn a URL into a metadata
 * API name, and one of them needs to derive the org's SCRT2 host. Both rules are small, both are
 * easy to get subtly wrong, and neither belongs to a single phase — so they live here with the
 * reasoning attached.
 */

/**
 * Turns a URL into a valid metadata API name.
 *
 * API names allow letters, digits and underscores and cannot start with a digit — so the scheme is
 * dropped, every other illegal character becomes an underscore, and a leading digit gets a prefix.
 *
 * `maxLength` differs per metadata type and is not cosmetic: RemoteSiteSetting rejects a name
 * longer than 40 characters ('Value too long for field: fullName maximum length is:40' — observed on
 * a real deploy), while CspTrustedSite accepts 80. Truncation can make two long URLs collide, which
 * is why every caller runs a duplicate-name check and tells the user about the `Name|url` form.
 */
export function deriveApiName(url: string, maxLength = 80): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
  let name = withoutScheme.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (name === '') name = 'TrustedSite';
  if (/^[0-9]/.test(name)) name = `Site_${name}`;
  return name.slice(0, maxLength);
}

/**
 * Derives the org's SCRT2 endpoint from its instance URL.
 *
 *   https://no-software-1234.scratch.my.salesforce.com
 *     -> https://no-software-1234.scratch.my.salesforce-scrt.com
 *
 * SCRT2 ("Service Cloud Real Time", version 2) is the conversation runtime that carries Voice calls.
 * Its host is the org's My Domain with `.my.salesforce.com` replaced by `.my.salesforce-scrt.com`,
 * which is why it can be computed rather than configured — and why it MUST be, since every scratch
 * org gets a different one.
 *
 * Returns `undefined` when the instance URL is not a My Domain URL (a legacy pod URL such as
 * `https://na139.salesforce.com`, for instance). Guessing there would produce a plausible-looking
 * host that does not exist, and a silently wrong endpoint is worse than a missing one.
 */
export function scrtUrlFor(instanceUrl: string): string | undefined {
  const trimmed = instanceUrl.trim().replace(/\/+$/, '');
  let host: string;
  try {
    host = new URL(trimmed).host;
  } catch {
    return undefined;
  }

  // Anchored on the suffix, so `.sandbox.my.salesforce.com` and `.scratch.my.salesforce.com` are
  // both handled, and a host that merely CONTAINS the string is not.
  const suffix = '.my.salesforce.com';
  if (!host.toLowerCase().endsWith(suffix)) return undefined;

  return `https://${host.slice(0, -suffix.length)}.my.salesforce-scrt.com`;
}

/** Compares two URLs for "the org already has this one", ignoring case and a trailing slash. */
export function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}
