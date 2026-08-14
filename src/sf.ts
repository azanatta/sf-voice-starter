/**
 * Thin, typed wrapper around the `sf` CLI.
 *
 * Design rules, so this file stays boring:
 *   - Every command runs with `--json`. Parsing human-readable CLI output is how automation rots.
 *   - Failures throw an `SfCommandError` carrying the parsed payload, so callers can branch on the
 *     org's actual error *name* rather than on substring matches against a message.
 *   - Nothing here knows about Voice. Voice knowledge lives in `src/phases/`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Shape of a `sf ... --json` response. */
interface SfJsonResponse<T> {
  status: number;
  result: T;
  message?: string;
  name?: string;
  /** Present on partial failures such as deploys with component errors. */
  data?: unknown;
  warnings?: string[];
}

export class SfCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    /** The CLI's error `name`, e.g. `GenericTimeoutError`. Branch on this, not on the message. */
    readonly errorName: string | undefined,
    /** Full parsed JSON payload when the CLI produced one, otherwise the raw output. */
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'SfCommandError';
  }
}

export interface SfRunOptions {
  /**
   * Max time to allow. Some commands (scratch org creation, package installation) legitimately run
   * for tens of minutes, so this defaults high rather than to Node's usual short fuse.
   */
  timeoutMs?: number;
  /** Log the command before running it. */
  onCommand?: (display: string) => void;
}

/**
 * Runs an `sf` command and returns the parsed `result` payload.
 *
 * `execFile` (not `exec`) is used deliberately: arguments are passed as an array and never go through
 * a shell, so a package installation key or an org name containing shell metacharacters cannot turn
 * into command injection.
 */
export async function sf<T = unknown>(args: string[], options: SfRunOptions = {}): Promise<T> {
  const { timeoutMs = 10 * 60_000, onCommand } = options;
  const withJson = args.includes('--json') ? args : [...args, '--json'];

  onCommand?.(`sf ${redact(withJson).join(' ')}`);

  let stdout: string;
  try {
    const result = await execFileAsync('sf', withJson, {
      timeout: timeoutMs,
      // Deploy and install responses can be large; the default 1 MB buffer overflows on big orgs.
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        // The CLI colorizes its JSON output when it believes the consumer wants colour — and it
        // believes that whenever FORCE_COLOR is set. The result is JSON peppered with ANSI escape
        // sequences, which does not parse.
        //
        // This is not hypothetical: the Playwright test runner sets FORCE_COLOR=1 for its children,
        // so every sf call made from a test failed with a parse error while the identical call from
        // the plain CLI succeeded. Many CI providers set it too. Force it off for our children.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });
    stdout = result.stdout;
  } catch (error) {
    // A non-zero exit is the *normal* path for a failed sf command, and the useful JSON payload is
    // still on stdout. Re-parse it rather than surfacing an opaque "Command failed".
    const execError = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };

    if (execError.killed) {
      throw new SfCommandError(
        `sf command timed out after ${timeoutMs}ms: sf ${redact(withJson).join(' ')}`,
        withJson,
        'TimeoutError',
        undefined,
      );
    }

    const parsed = tryParse<SfJsonResponse<T>>(execError.stdout ?? '');
    if (parsed) {
      throw new SfCommandError(
        parsed.message ?? 'sf command failed',
        withJson,
        parsed.name,
        parsed,
      );
    }
    throw new SfCommandError(
      execError.stderr?.trim() || execError.message || 'sf command failed with no output',
      withJson,
      undefined,
      execError.stdout ?? execError.stderr,
    );
  }

  const parsed = tryParse<SfJsonResponse<T>>(stdout);
  if (!parsed) {
    // Always show what was actually received. "Not JSON" on its own sends the reader hunting; the
    // first few hundred characters usually name the problem outright (a CLI warning banner, an
    // auth prompt, a proxy error page).
    throw new SfCommandError(
      `sf produced output that is not JSON.\n` +
        `Command: sf ${redact(withJson).join(' ')}\n` +
        `Received: ${JSON.stringify(stdout.slice(0, 400))}`,
      withJson,
      undefined,
      stdout,
    );
  }
  // Not every command wraps its output in the `{status, result}` envelope — `sf version --json`, for
  // one, returns a bare object. Treat a payload with neither field as the result itself rather than
  // reading its absent `status` as a failure.
  if (parsed.status === undefined && parsed.result === undefined) {
    return parsed as unknown as T;
  }

  if (parsed.status !== 0) {
    throw new SfCommandError(parsed.message ?? 'sf command failed', withJson, parsed.name, parsed);
  }
  return parsed.result;
}

/**
 * Runs a command and returns `undefined` instead of throwing.
 *
 * Use this only where failure is a legitimate answer to a question ("does this org exist?"), never to
 * paper over an error you have not thought about.
 */
export async function sfOptional<T>(args: string[], options: SfRunOptions = {}): Promise<T | undefined> {
  try {
    return await sf<T>(args, options);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Typed helpers for the specific commands this project uses.
 * ---------------------------------------------------------------------------------------------- */

export interface OrgDisplay {
  username: string;
  orgId: string;
  accessToken: string;
  instanceUrl: string;
  alias?: string;
  expirationDate?: string;
  status?: string;
}

/** `sf org display` — also how we obtain the session token used to drive the browser. */
export function orgDisplay(orgAlias: string, options?: SfRunOptions): Promise<OrgDisplay> {
  return sf<OrgDisplay>(['org', 'display', '--target-org', orgAlias], options);
}

export interface QueryResult<T> {
  totalSize: number;
  done: boolean;
  records: T[];
}

/**
 * Runs SOQL against an org.
 *
 * Prefer this over reading metadata when you want to know the *actual* state of an org. Several Voice
 * settings misreport through the Metadata API but are perfectly visible as data (permission sets,
 * permission set licenses, vendor infos).
 */
export function query<T = Record<string, unknown>>(
  orgAlias: string,
  soql: string,
  options?: SfRunOptions & { useToolingApi?: boolean },
): Promise<QueryResult<T>> {
  const args = ['data', 'query', '--target-org', orgAlias, '--query', soql];
  if (options?.useToolingApi) args.push('--use-tooling-api');
  return sf<QueryResult<T>>(args, options);
}

/** Redacts secrets so a logged command line is safe to paste into a ticket. */
function redact(args: string[]): string[] {
  const secretFlags = new Set(['--installation-key', '-k']);
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (previous !== undefined && secretFlags.has(previous)) return '***';
    if (arg.startsWith('--installation-key=')) return '--installation-key=***';
    // Session tokens must never reach a log file.
    if (/^00D[a-zA-Z0-9]{12,}!/.test(arg)) return '***';
    return arg;
  });
}

function tryParse<T>(text: string): T | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}
