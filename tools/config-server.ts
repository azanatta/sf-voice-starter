#!/usr/bin/env node
/**
 * Local configuration UI.
 *
 *   npm run configure                     start the server and print the URL
 *   npm run configure -- --write-env-example   regenerate .env.example from the schema and exit
 *
 * ============================================================================================
 * WHAT THIS IS AND IS NOT
 * ============================================================================================
 * It is a small local-only HTTP server that renders `config/settings-schema.ts` as a form, validates
 * the values, writes `.env`, and can launch a run while streaming its output back to the page.
 *
 * It is NOT a second place to define settings. The form is generated from the schema at request
 * time, so a field cannot exist here that does not exist in the schema, and a schema default cannot
 * disagree with what the form shows.
 *
 * SECURITY: it binds to 127.0.0.1 only, and it can spawn a process (that is the point — it runs the
 * setup). Do not make it listen on 0.0.0.0. Values marked `secret` in the schema are never sent to
 * the browser; a placeholder is shown and an unchanged placeholder is not written back.
 * ============================================================================================
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { SETTINGS, settingGroups, validateAll, type Setting } from '../config/settings-schema.js';

const PORT = Number.parseInt(process.env['SCV_CONFIG_PORT'] ?? '4747', 10);
const ENV_PATH = resolve(process.cwd(), '.env');
const PROFILES_PATH = resolve(process.cwd(), 'config/profiles.json');
const UI_PATH = resolve(process.cwd(), 'tools/config-ui.html');

/** Masked stand-in for secret values, so the real one never reaches the browser. */
const SECRET_PLACEHOLDER = '••••••••';

/* -------------------------------------------------------------------------------------------------
 * .env read / write
 * ---------------------------------------------------------------------------------------------- */

/** Parses a `.env` file into a map. Ignores comments and blank lines. */
function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/**
 * Writes `.env`, grouped and commented from the schema.
 *
 * Only values that DIFFER from the schema default are written. That keeps the file short and, more
 * usefully, makes it obvious at a glance what has been customised — a file restating thirty defaults
 * hides the two lines that matter.
 */
function writeEnvFile(values: Record<string, string>): string[] {
  const written: string[] = [];
  const lines: string[] = [
    '# Written by `npm run configure`. Values equal to the default are omitted on purpose,',
    '# so what remains is exactly what has been customised.',
    '',
  ];

  for (const group of settingGroups()) {
    const groupSettings = SETTINGS.filter(
      (setting) => setting.group === group && (values[setting.env] ?? '') !== setting.default,
    );
    if (groupSettings.length === 0) continue;

    lines.push(`# ${'-'.repeat(90)}`, `# ${group}`, `# ${'-'.repeat(90)}`);
    for (const setting of groupSettings) {
      lines.push(`# ${setting.description}`);
      lines.push(`${setting.env}=${values[setting.env] ?? ''}`);
      written.push(setting.env);
    }
    lines.push('');
  }

  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  return written;
}

/** Regenerates `.env.example` from the schema, documenting every setting with its default. */
function writeEnvExample(): void {
  const lines: string[] = [
    '# Copy to `.env` and adjust — or run `npm run configure` for a form with validation.',
    '# GENERATED from config/settings-schema.ts. Edit the schema, not this file.',
    '#',
    '# The setup script reads process.env directly; load this with your shell, direnv, or',
    '# `node --env-file=.env`.',
    '',
  ];

  for (const group of settingGroups()) {
    lines.push(`# ${'-'.repeat(90)}`, `# ${group}`, `# ${'-'.repeat(90)}`);
    for (const setting of SETTINGS.filter((entry) => entry.group === group)) {
      lines.push(`# ${setting.description}`);
      if (setting.options?.length) {
        lines.push(`# Options: ${setting.options.map((o) => o || '(empty)').join(' | ')}`);
      }
      // Commented out so the file is documentation, not an override of every default.
      lines.push(`# ${setting.env}=${setting.default}`);
      lines.push('');
    }
  }

  writeFileSync(resolve(process.cwd(), '.env.example'), lines.join('\n'), 'utf8');
}

/* -------------------------------------------------------------------------------------------------
 * Profiles
 * ---------------------------------------------------------------------------------------------- */

interface Profiles {
  [name: string]: Record<string, string>;
}

function readProfiles(): Profiles {
  if (!existsSync(PROFILES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PROFILES_PATH, 'utf8')) as Profiles;
  } catch {
    return {};
  }
}

function writeProfiles(profiles: Profiles): void {
  writeFileSync(PROFILES_PATH, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------------------------------
 * Validation beyond the schema's own rules
 * ---------------------------------------------------------------------------------------------- */

/**
 * Checks that cannot live in the schema because they touch the filesystem.
 *
 * These are the ones worth catching before a six-minute run: a vendor XML that is not there, and an
 * internal name that disagrees with the file about to be imported.
 */
function environmentChecks(values: Record<string, string>): Record<string, string> {
  const warnings: Record<string, string> = {};

  // The single most common way a run dies at second zero: an unauthenticated Dev Hub, or one whose
  // refresh token has quietly expired. `sf org list` happily lists the latter, so ask the CLI to
  // actually resolve it.
  const devHub = (values['SCV_DEVHUB_ALIAS'] ?? '').trim();
  if (devHub !== '') {
    const check = spawnSync('sf', ['org', 'display', '--target-org', devHub, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    // CAUTION: a non-zero exit is NOT the failure signal here. `sf org display` exits 0 for an org
    // whose refresh token has expired and reports the problem only in `result.connectedStatus`
    // ("Unable to refresh session due to: ..."). Checking the exit code alone silently passes exactly
    // the case this check exists to catch.
    let problem: string | undefined;
    if (check.status !== 0) {
      problem = 'not authenticated';
    } else {
      try {
        const parsed = JSON.parse(check.stdout) as {
          result?: { connectedStatus?: string };
        };
        const status = parsed.result?.connectedStatus;
        if (status && status !== 'Connected') problem = status;
      } catch {
        problem = 'could not read the CLI response';
      }
    }

    if (problem) {
      warnings['SCV_DEVHUB_ALIAS'] =
        `${problem}. Re-authenticate with: sf org login web --set-default-dev-hub --alias ${devHub}`;
    }
  }

  const xmlPath = values['SCV_CC_DEFINITION_FILE'] ?? '';
  const wantsContactCenter = ['true', '1', 'yes', 'on'].includes(
    (values['SCV_CREATE_CONTACT_CENTER'] ?? 'true').toLowerCase(),
  );

  // Asking to import a contact center without a package to install cannot work: the wizard lists
  // telephony providers from ConversationVendorInfo records that ship INSIDE the vendor package, so
  // with no package there is nothing to choose. Catching it here is the difference between a warning
  // now and discovering it several minutes into a run.
  if (wantsContactCenter && (values['SCV_PACKAGE_VERSION_ID'] ?? '').trim() === '') {
    warnings['SCV_PACKAGE_VERSION_ID'] =
      'Needed to import a contact center — the telephony provider list comes from the vendor package. ' +
      'Either set it, or turn "Import contact center" off to stop at "ready to install".';
  }

  if (wantsContactCenter && xmlPath.trim() !== '') {
    const full = resolve(process.cwd(), xmlPath);
    if (!existsSync(full)) {
      warnings['SCV_CC_DEFINITION_FILE'] =
        'File not found. The contact center phase will skip and report a manual step.';
    } else {
      const xml = readFileSync(full, 'utf8');
      const internal = xml.match(/name="reqInternalName"[^>]*>([^<]+)</)?.[1]?.trim();
      const configured = (values['SCV_CC_INTERNAL_NAME'] ?? '').trim();
      if (configured !== '' && internal && configured !== internal) {
        warnings['SCV_CC_INTERNAL_NAME'] =
          `The XML says "${internal}". A different value here makes every run re-import. ` +
          'Leave it empty to take it from the file.';
      }
      if (!/name="reqVendorInfoApiName"[^>]*>[^<]+</.test(xml)) {
        warnings['SCV_CC_DEFINITION_FILE'] =
          'This file has no reqVendorInfoApiName value, so the telephony provider cannot be derived.';
      }
    }
  }
  return warnings;
}

/* -------------------------------------------------------------------------------------------------
 * Run streaming
 * ---------------------------------------------------------------------------------------------- */

/** Subscribers to the current run's output. */
const streamClients = new Set<ServerResponse>();
let activeRun: ChildProcess | undefined;

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of streamClients) client.write(payload);
}

function startRun(values: Record<string, string>, args: string[]): void {
  if (activeRun) throw new Error('A run is already in progress.');

  // NO_COLOR keeps ANSI escapes out of the browser; the page does its own highlighting.
  const child = spawn('npx', ['tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...values, NO_COLOR: '1', FORCE_COLOR: '0' },
  });

  activeRun = child;
  broadcast('started', { args });

  const relay = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') broadcast('line', { line });
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);

  child.on('close', (code) => {
    activeRun = undefined;
    broadcast('finished', { code });
  });
}

/* -------------------------------------------------------------------------------------------------
 * HTTP
 * ---------------------------------------------------------------------------------------------- */

/** Strips values the browser must not see, and describes the schema for the form. */
function publicState() {
  const envValues = readEnvFile();
  const values: Record<string, string> = {};

  for (const setting of SETTINGS) {
    const current = envValues[setting.env] ?? setting.default;
    values[setting.env] = setting.secret && current !== '' ? SECRET_PLACEHOLDER : current;
  }

  return {
    settings: SETTINGS.map((setting: Setting) => ({
      env: setting.env,
      label: setting.label,
      description: setting.description,
      type: setting.type,
      default: setting.default,
      group: setting.group,
      options: setting.options ?? null,
      secret: setting.secret ?? false,
      placeholder: setting.placeholder ?? '',
    })),
    groups: settingGroups(),
    values,
    profiles: Object.keys(readProfiles()),
    envPath: ENV_PATH,
  };
}

/** Re-inserts real secret values where the browser sent back the untouched placeholder. */
function restoreSecrets(incoming: Record<string, string>): Record<string, string> {
  const existing = readEnvFile();
  const merged = { ...incoming };
  for (const setting of SETTINGS) {
    if (setting.secret && merged[setting.env] === SECRET_PLACEHOLDER) {
      merged[setting.env] = existing[setting.env] ?? '';
    }
  }
  return merged;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = readFileSync(UI_PATH, 'utf8');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, publicState());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/validate') {
      const body = await readBody(request);
      const values = (body['values'] ?? {}) as Record<string, string>;
      sendJson(response, 200, {
        errors: validateAll(values),
        warnings: environmentChecks(values),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(request);
      const values = restoreSecrets((body['values'] ?? {}) as Record<string, string>);
      const errors = validateAll(values);
      if (Object.keys(errors).length > 0) {
        sendJson(response, 400, { errors });
        return;
      }
      const written = writeEnvFile(values);
      sendJson(response, 200, { written, path: ENV_PATH });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/profiles/save') {
      const body = await readBody(request);
      const name = String(body['name'] ?? '').trim();
      if (name === '') {
        sendJson(response, 400, { error: 'A profile needs a name.' });
        return;
      }
      const values = (body['values'] ?? {}) as Record<string, string>;
      // Secrets are deliberately NOT stored in a profile: profiles are meant to be shareable and
      // committable, and an installation key in a JSON file is exactly the kind of thing that leaks.
      const safe: Record<string, string> = {};
      for (const setting of SETTINGS) {
        if (setting.secret) continue;
        if (values[setting.env] !== undefined) safe[setting.env] = values[setting.env] as string;
      }
      const profiles = readProfiles();
      profiles[name] = safe;
      writeProfiles(profiles);
      sendJson(response, 200, { profiles: Object.keys(profiles) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/profiles/load') {
      const name = url.searchParams.get('name') ?? '';
      const profiles = readProfiles();
      const profile = profiles[name];
      if (!profile) {
        sendJson(response, 404, { error: `No profile named "${name}".` });
        return;
      }
      sendJson(response, 200, { values: profile });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/profiles/delete') {
      const body = await readBody(request);
      const profiles = readProfiles();
      delete profiles[String(body['name'] ?? '')];
      writeProfiles(profiles);
      sendJson(response, 200, { profiles: Object.keys(profiles) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      streamClients.add(response);
      request.on('close', () => streamClients.delete(response));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/run') {
      const body = await readBody(request);
      const values = restoreSecrets((body['values'] ?? {}) as Record<string, string>);
      const args = (body['args'] ?? []) as string[];

      const errors = validateAll(values);
      if (Object.keys(errors).length > 0) {
        sendJson(response, 400, { errors });
        return;
      }
      try {
        startRun(values, args);
        sendJson(response, 200, { started: true });
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/stop') {
      activeRun?.kill('SIGINT');
      sendJson(response, 200, { stopped: true });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

/* -------------------------------------------------------------------------------------------------
 * Entry
 * ---------------------------------------------------------------------------------------------- */

if (process.argv.includes('--write-env-example')) {
  writeEnvExample();
  console.log('Regenerated .env.example from config/settings-schema.ts');
} else {
  // An already-running instance is the common case (a forgotten tab from earlier), and Node's
  // default behaviour is an unhandled EADDRINUSE stack trace that buries the one useful fact.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${PORT} is already in use — the configuration UI is probably already running.\n` +
          `  Open http://127.0.0.1:${PORT}, or stop the other instance, or pick another port:\n` +
          `      SCV_CONFIG_PORT=4748 npm run configure\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  });

  // 127.0.0.1, never 0.0.0.0: this endpoint can spawn a process.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Configuration UI → http://127.0.0.1:${PORT}\n`);
    console.log('  Ctrl-C to stop.\n');
  });
}
