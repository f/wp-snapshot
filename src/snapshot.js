import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import ipaddr from 'ipaddr.js';
import robotsParser from 'robots-parser';
import { Agent } from 'undici';
import { transformCss } from './css.js';
import { transformHtml } from './html.js';
import { transformJavaScript } from './javascript.js';
import { transformManifest } from './manifest.js';
import { VERSION } from './version.js';
import {
  assetOutputPath,
  ensureUniqueOutput,
  isDynamicPage,
  normalizeKey,
  normalizeUrl,
  pageOutputPath,
  relativeFileReference,
  relativePageReference,
} from './url.js';

const DEFAULT_USER_AGENT = `wp-snapshot/${VERSION} (+https://www.npmjs.com/package/wp-snapshot)`;
const WORDPRESS_API_RELATION = 'https://api.w.org/';
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

export class SnapshotError extends Error {
  constructor(message, code = 'E_SNAPSHOT', cause) {
    super(message, { cause });
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function contentKind(contentType, url, requestedKind, buffer) {
  const type = contentType.toLowerCase();
  if (type.includes('text/html') || type.includes('application/xhtml+xml')) return 'html';
  if (type.includes('text/css')) return 'css';
  if (type.includes('manifest+json') || /\.webmanifest$/i.test(url.pathname)) return 'manifest';
  if (type.includes('javascript') || /\.(?:m?js)$/i.test(url.pathname)) return 'javascript';
  if (requestedKind === 'page' && /^\s*(?:<!doctype\s+html|<html\b)/i.test(buffer.toString('utf8', 0, 512))) {
    return 'html';
  }
  return 'asset';
}

function addContentExtension(outputPath, contentType, kind) {
  const extension = path.posix.extname(outputPath).toLowerCase();
  if (kind === 'css' && extension !== '.css') return `${outputPath}.css`;
  if (kind === 'javascript' && !['.js', '.mjs'].includes(extension)) return `${outputPath}.js`;
  if (kind === 'manifest' && !['.json', '.webmanifest'].includes(extension)) return `${outputPath}.webmanifest`;
  if (extension) return outputPath;

  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  const inferred = new Map([
    ['application/json', '.json'],
    ['application/pdf', '.pdf'],
    ['application/wasm', '.wasm'],
    ['application/xml', '.xml'],
    ['audio/mpeg', '.mp3'],
    ['audio/ogg', '.ogg'],
    ['font/otf', '.otf'],
    ['font/ttf', '.ttf'],
    ['font/woff', '.woff'],
    ['font/woff2', '.woff2'],
    ['image/avif', '.avif'],
    ['image/gif', '.gif'],
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/svg+xml', '.svg'],
    ['image/webp', '.webp'],
    ['text/plain', '.txt'],
    ['text/xml', '.xml'],
    ['video/mp4', '.mp4'],
    ['video/webm', '.webm'],
  ]).get(type);
  return inferred ? `${outputPath}${inferred}` : outputPath;
}

function textDecoderFor(contentType) {
  const match = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType);
  const charset = match?.[1]?.trim().toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder('utf-8');
  }
}

function normalizeHeaders(headers) {
  const result = new Headers(headers);
  if (!result.has('user-agent')) result.set('user-agent', DEFAULT_USER_AGENT);
  result.set('accept-encoding', 'gzip, deflate, br');
  return result;
}

function publicUrlForOutput(publicUrl, outputPath) {
  if (!publicUrl) return null;
  const base = new URL(publicUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const canonicalPath = outputPath.endsWith('index.html')
    ? outputPath.slice(0, -'index.html'.length)
    : outputPath;
  const encodedPath = canonicalPath.split('/').map(encodeURIComponent).join('/');
  return new URL(encodedPath, base).href;
}

function serializableResource(record, redact = false) {
  return {
    url: redact ? redactUrl(record.url) : record.url,
    output: record.outputPath,
    kind: record.kind,
    contentType: record.contentType,
    status: record.status,
    bytes: record.bytes,
  };
}

function isSensitiveQueryKey(key) {
  return /(?:^|[-_])(?:auth|credential|expires?|key|nonce|passw(?:or)?d|policy|secret|signature|sig|token)(?:$|[-_])/i.test(key)
    || /^(?:x-amz|x-goog)-/i.test(key)
    || /^key-pair-id$/i.test(key);
}

function redactUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryKey(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.href;
  } catch {
    return value;
  }
}

function redactText(value) {
  if (!value) return value;
  return value.replace(/https?:\/\/[^\s]+/gi, (match) => redactUrl(match));
}

function redactIssue(issue) {
  return {
    ...issue,
    url: redactUrl(issue.url),
    referrer: redactUrl(issue.referrer),
    message: redactText(issue.message),
  };
}

function isWordPressApiRelation(value) {
  try {
    return new URL(value).href === WORDPRESS_API_RELATION;
  } catch {
    return false;
  }
}

function splitLinkHeader(value) {
  const entries = [];
  let start = 0;
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angled = true;
    else if (!quoted && character === '>') angled = false;
    else if (!quoted && !angled && character === ',') {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

function restApiLinksFromHeader(value) {
  if (!value) return [];
  const links = [];
  for (const entry of splitLinkHeader(value)) {
    const target = /^\s*<([^>]+)>/.exec(entry)?.[1];
    if (!target) continue;
    for (const match of entry.matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/gi)) {
      const relations = (match[1] ?? match[2] ?? '').split(/\s+/);
      if (relations.some(isWordPressApiRelation)) links.push(target);
    }
  }
  return links;
}

function isWordPressRestIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    !Array.isArray(value.namespaces)
    || !value.routes
    || typeof value.routes !== 'object'
    || Array.isArray(value.routes)
  ) {
    return false;
  }
  const hasCoreNamespace = value.namespaces.some(
    (namespace) => typeof namespace === 'string'
      && (namespace === 'wp/v2' || namespace.startsWith('wp/v2/')),
  );
  const hasCoreRoute = Object.keys(value.routes).some(
    (route) => route === '/wp/v2' || route.startsWith('/wp/v2/'),
  );
  return hasCoreNamespace && hasCoreRoute;
}

function isProtectedWordPressRestResponse(value, status, advertised) {
  if (!advertised || ![401, 403].includes(status)) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reportedStatus = Number(value.data?.status);
  return typeof value.code === 'string'
    && value.code.startsWith('rest_')
    && [401, 403].includes(reportedStatus);
}

export async function snapshot(inputOptions) {
  const options = {
    outputDir: path.resolve('snapshot'),
    clean: false,
    forceClean: false,
    concurrency: 8,
    maxPages: 1000,
    maxAssets: 5000,
    maxQueryVariants: 25,
    maxResourceBytes: 50 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    timeout: 30_000,
    maxRedirects: 10,
    robots: true,
    sitemap: true,
    capture404: true,
    skipWordPressCheck: false,
    externalAssets: false,
    allowPrivateNetwork: false,
    strict: false,
    report: true,
    publicUrl: null,
    headers: {},
    onProgress: () => {},
    ...inputOptions,
  };

  if (typeof options.onProgress !== 'function') options.onProgress = () => {};
  if (options.forceClean) options.clean = true;

  if (!options.url) throw new SnapshotError('A WordPress URL is required.', 'E_URL');
  const requestedSeed = normalizeUrl(options.url);
  if (!requestedSeed) throw new SnapshotError('The WordPress URL must use http:// or https://.', 'E_URL');

  options.outputDir = path.resolve(options.outputDir);
  if (options.publicUrl) {
    try {
      const publicUrl = new URL(options.publicUrl);
      if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') throw new Error();
      options.publicUrl = publicUrl.href;
    } catch {
      throw new SnapshotError('publicUrl must use http:// or https://.', 'E_OPTION');
    }
  }
  validateNumberOptions(options);
  options.outputDir = await validateOutputDirectory(options.outputDir, options.clean, options.forceClean);

  const parentDirectory = path.dirname(options.outputDir);
  await fs.mkdir(parentDirectory, { recursive: true });
  const stageDirectory = await fs.mkdtemp(path.join(parentDirectory, `.${path.basename(options.outputDir)}.wp-snapshot-`));

  const state = createState(options, requestedSeed, stageDirectory);
  try {
    const seedFetch = await fetchWithRedirects(state, requestedSeed, 'page', true);
    if (!seedFetch.response.ok) {
      throw new SnapshotError(`The WordPress homepage returned HTTP ${seedFetch.response.status}.`, 'E_SOURCE');
    }

    state.primaryOrigins.add(seedFetch.finalUrl.origin);
    state.siteUrl = seedFetch.finalUrl;
    const seedRecord = await captureResponse(state, {
      url: requestedSeed,
      kind: 'page',
      relation: 'seed',
      seed: true,
      deferDiscovery: true,
    }, seedFetch);

    if (seedRecord.kind !== 'html') {
      throw new SnapshotError('The WordPress URL must point to a public HTML page.', 'E_SOURCE');
    }
    if (options.skipWordPressCheck) {
      addWarning(state, 'WordPress verification was skipped.', state.siteUrl.href);
    } else {
      await verifyWordPress(state, seedFetch.response.headers, seedRecord);
    }

    await loadRobots(state);
    const seedPath = path.join(state.stageDirectory, ...seedRecord.outputPath.split('/'));
    await discoverFromRecord(state, seedRecord, await fs.readFile(seedPath));

    await discoverSitemaps(state);

    if (options.capture404) {
      const missing = new URL('__wp_snapshot_missing_page__/', seedFetch.finalUrl);
      enqueue(state, {
        url: missing,
        kind: 'page',
        relation: '404',
        special404: true,
      });
    }

    await drainQueue(state);
    throwIfAborted(state);
    await rewriteCapturedFiles(state);
    await writeSupportFiles(state);

    if (options.strict && state.failures.length > 0) {
      throw new SnapshotError(
        `Snapshot has ${state.failures.length} failed request${state.failures.length === 1 ? '' : 's'}.`,
        'E_STRICT',
      );
    }

    const revalidatedOutput = await validateOutputDirectory(
      options.outputDir,
      options.clean,
      options.forceClean,
    );
    if (revalidatedOutput !== options.outputDir) {
      throw new SnapshotError('The output path changed while the snapshot was running.', 'E_OUTPUT_CHANGED');
    }
    await commitStage(stageDirectory, options.outputDir);
    state.stageDirectory = options.outputDir;
    return buildResult(state);
  } catch (error) {
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    if (state.options.signal?.aborted && error?.code !== 'E_ABORT') {
      throw new SnapshotError('Snapshot was interrupted.', 'E_ABORT', error);
    }
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(error.message, 'E_SNAPSHOT', error);
  } finally {
    await closeExternalDispatchers(state);
  }
}

function createState(options, requestedSeed, stageDirectory) {
  const claimedOutputs = new Map([
    ['.nojekyll', '__wp_snapshot_reserved__'],
    ['.wp-snapshot-output', '__wp_snapshot_reserved__'],
    ['wp-snapshot.json', '__wp_snapshot_reserved__'],
  ]);
  if (options.capture404) claimedOutputs.set('404.html', '__wp_snapshot_404__');

  return {
    options,
    requestedSeed,
    siteUrl: requestedSeed,
    stageDirectory,
    primaryOrigins: new Set([requestedSeed.origin]),
    queue: [],
    scheduled: new Set(),
    records: [],
    captured: new Map(),
    aliases: new Map(),
    claimedOutputs,
    pageCount: 0,
    assetCount: 0,
    totalBytes: 0,
    inFlightBytes: 0,
    robots: null,
    robotsOrigin: null,
    queryVariants: new Map(),
    scheduledPageCount: 1,
    scheduledAssetCount: 0,
    failures: [],
    skipped: [],
    warnings: [],
    liveDependencies: new Set(),
    sitemapUrls: new Set(),
    networkSafety: new Map(),
    externalDispatchers: new Map(),
    wordpressApiUrl: null,
    wordpressVerification: options.skipWordPressCheck ? 'skipped' : null,
  };
}

function validateNumberOptions(options) {
  for (const key of [
    'concurrency', 'maxPages', 'maxAssets', 'maxQueryVariants', 'maxResourceBytes',
    'maxTotalBytes', 'timeout', 'maxRedirects',
  ]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new SnapshotError(`${key} must be a positive integer.`, 'E_OPTION');
    }
  }
}

async function canonicalizePath(target) {
  let current = target;
  const missing = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function validateOutputDirectory(outputDir, clean, forceClean) {
  let originalStat;
  try {
    originalStat = await fs.lstat(outputDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (originalStat?.isSymbolicLink()) {
    throw new SnapshotError('The output directory cannot be a symbolic link.', 'E_OUTPUT');
  }

  const canonicalOutput = await canonicalizePath(outputDir);
  const canonicalHome = await fs.realpath(os.homedir()).catch(() => os.homedir());
  const canonicalCwd = await fs.realpath(process.cwd()).catch(() => process.cwd());
  const root = path.parse(canonicalOutput).root;
  const dangerous = new Set([root, canonicalHome, canonicalCwd]);
  const containsCurrentDirectory = (() => {
    const relative = path.relative(canonicalOutput, canonicalCwd);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  })();
  if (dangerous.has(canonicalOutput) || containsCurrentDirectory) {
    throw new SnapshotError(`Refusing to use a dangerous output directory: ${canonicalOutput}`, 'E_OUTPUT');
  }

  let stat;
  try {
    stat = await fs.lstat(canonicalOutput);
  } catch (error) {
    if (error.code === 'ENOENT') return canonicalOutput;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new SnapshotError('The output directory cannot be a symbolic link.', 'E_OUTPUT');
  }
  if (!stat.isDirectory()) {
    throw new SnapshotError('The output path exists and is not a directory.', 'E_OUTPUT');
  }
  const entries = await fs.readdir(canonicalOutput);
  if (entries.length > 0 && !clean) {
    throw new SnapshotError('The output directory is not empty. Use --clean to replace it.', 'E_OUTPUT_NOT_EMPTY');
  }
  if (entries.some((entry) => ['.git', '.hg', '.svn'].includes(entry))) {
    throw new SnapshotError('Refusing to replace a version-control root.', 'E_OUTPUT');
  }
  if (
    entries.length > 0
    && clean
    && !forceClean
    && !entries.includes('.wp-snapshot-output')
    && !entries.includes('wp-snapshot.json')
  ) {
    throw new SnapshotError(
      'The output is not marked as a wp-snapshot directory. Use --force-clean to replace it.',
      'E_OUTPUT_UNMARKED',
    );
  }
  return canonicalOutput;
}

async function commitStage(stageDir, outputDir) {
  const currentOutputIdentity = await canonicalizePath(outputDir);
  const stageIdentity = await fs.realpath(stageDir);
  if (
    currentOutputIdentity !== outputDir
    || path.dirname(stageIdentity) !== path.dirname(outputDir)
  ) {
    throw new SnapshotError('The output path changed while the snapshot was running.', 'E_OUTPUT_CHANGED');
  }
  try {
    const outputStat = await fs.lstat(outputDir);
    if (outputStat.isSymbolicLink()) {
      throw new SnapshotError('The output directory became a symbolic link.', 'E_OUTPUT_CHANGED');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let outputExists = false;
  try {
    await fs.lstat(outputDir);
    outputExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!outputExists) {
    await fs.rename(stageDir, outputDir);
    return;
  }

  const backup = `${outputDir}.wp-snapshot-backup-${Date.now()}`;
  await fs.rename(outputDir, backup);
  try {
    await fs.rename(stageDir, outputDir);
  } catch (error) {
    await fs.rename(backup, outputDir).catch(() => {});
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true });
}

function headersForRequest(state, targetUrl, stripSensitive = false) {
  const headers = normalizeHeaders(state.options.headers);
  if (stripSensitive || !state.primaryOrigins.has(targetUrl.origin)) {
    for (const header of SENSITIVE_HEADERS) headers.delete(header);
  }
  return headers;
}

function isPrivateIpAddress(rawAddress) {
  const address = rawAddress.replace(/^\[|\]$/g, '').toLowerCase();
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address().range() !== 'unicast';
  }
  return parsed.range() !== 'unicast';
}

async function safeExternalAddresses(state, url) {
  if (state.options.allowPrivateNetwork || state.primaryOrigins.has(url.origin)) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname)) {
    if (!isPrivateIpAddress(hostname)) return null;
    throw new SnapshotError(`Refusing an external private-network URL: ${url.href}`, 'E_PRIVATE_NETWORK');
  }

  let lookup = state.networkSafety.get(hostname);
  if (!lookup) {
    lookup = dns.lookup(hostname, { all: true, verbatim: true });
    state.networkSafety.set(hostname, lookup);
  }
  const addresses = await lookup;
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIpAddress(address))) {
    throw new SnapshotError(`Refusing an external private-network URL: ${url.href}`, 'E_PRIVATE_NETWORK');
  }
  return addresses;
}

function pinnedDispatcher(state, hostname, addresses) {
  let dispatcher = state.externalDispatchers.get(hostname);
  if (dispatcher) return dispatcher;

  let cursor = 0;
  dispatcher = new Agent({
    connect: {
      lookup(requestedHostname, options, callback) {
        const requested = requestedHostname.replace(/^\[|\]$/g, '');
        if (requested !== hostname) {
          callback(new Error(`Unexpected DNS lookup for ${requestedHostname}`));
          return;
        }
        const requestedFamily = typeof options === 'number' ? options : options?.family;
        const candidates = requestedFamily
          ? addresses.filter(({ family }) => family === requestedFamily)
          : addresses;
        if (candidates.length === 0) {
          const error = new Error(`No validated address for ${requestedHostname}`);
          error.code = 'ENOTFOUND';
          callback(error);
          return;
        }
        if (typeof options === 'object' && options?.all) {
          callback(null, candidates);
          return;
        }
        const selected = candidates[cursor % candidates.length];
        cursor += 1;
        callback(null, selected.address, selected.family);
      },
    },
  });
  state.externalDispatchers.set(hostname, dispatcher);
  return dispatcher;
}

async function closeExternalDispatchers(state) {
  await Promise.allSettled([...state.externalDispatchers.values()].map((dispatcher) => dispatcher.close()));
  state.externalDispatchers.clear();
}

async function fetchWithRedirects(state, requestedUrl, kind, allowOriginChange = false) {
  let current = new URL(requestedUrl);
  const redirects = [];
  let leftPrimaryOrigin = !state.primaryOrigins.has(current.origin);

  for (let count = 0; count <= state.options.maxRedirects; count += 1) {
    let dispatcher;
    if (kind === 'asset' && !allowOriginChange && !state.primaryOrigins.has(current.origin)) {
      if (!state.options.externalAssets) {
        throw new SnapshotError(`External asset capture is disabled: ${current.href}`, 'E_SCOPE');
      }
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const addresses = await safeExternalAddresses(state, current);
      if (addresses) dispatcher = pinnedDispatcher(state, hostname, addresses);
    } else if (!state.primaryOrigins.has(current.origin)) {
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const addresses = await safeExternalAddresses(state, current);
      if (addresses) dispatcher = pinnedDispatcher(state, hostname, addresses);
    }

    let response;
    try {
      response = await fetch(current, {
        headers: headersForRequest(state, current, leftPrimaryOrigin),
        redirect: 'manual',
        signal: state.options.signal
          ? AbortSignal.any([state.options.signal, AbortSignal.timeout(state.options.timeout)])
          : AbortSignal.timeout(state.options.timeout),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (state.options.signal?.aborted) {
        throw new SnapshotError('Snapshot was interrupted.', 'E_ABORT', error);
      }
      throw new SnapshotError(`Could not fetch ${current.href}: ${error.message}`, 'E_FETCH', error);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current, redirects };
    }

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current, redirects };
    const next = normalizeUrl(location, current);
    if (!next) throw new SnapshotError(`Invalid redirect from ${current.href}.`, 'E_REDIRECT');
    if (kind === 'page' && !allowOriginChange && !state.primaryOrigins.has(next.origin)) {
      throw new SnapshotError(`Page redirect left the WordPress origin: ${next.href}`, 'E_SCOPE');
    }
    if (!state.primaryOrigins.has(next.origin)) leftPrimaryOrigin = true;
    redirects.push({ from: current.href, to: next.href, status: response.status });
    current = next;
  }

  throw new SnapshotError(`Too many redirects for ${requestedUrl.href}.`, 'E_REDIRECT');
}

async function readResponseBuffer(state, response, url) {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > state.options.maxResourceBytes) {
    throw new SnapshotError(`Resource is larger than maxResourceBytes: ${url.href}`, 'E_SIZE');
  }
  let reservedBytes = 0;
  try {
    const buffer = await readBodyLimited(response, state.options.maxResourceBytes, (bytes) => {
      if (state.totalBytes + state.inFlightBytes + bytes > state.options.maxTotalBytes) {
        throw new SnapshotError('Snapshot is larger than maxTotalBytes.', 'E_SIZE');
      }
      state.inFlightBytes += bytes;
      reservedBytes += bytes;
    });
    return { buffer, reservedBytes };
  } catch (error) {
    state.inFlightBytes -= reservedBytes;
    throw error;
  }
}

function throwIfAborted(state, error) {
  if (state.options.signal?.aborted) {
    throw new SnapshotError('Snapshot was interrupted.', 'E_ABORT', error);
  }
}

async function readBodyLimited(response, limit, reserve = () => {}) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel('Resource exceeded the configured byte limit').catch(() => {});
        throw new SnapshotError('Response body exceeds the configured byte limit.', 'E_SIZE');
      }
      reserve(value.byteLength);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function captureResponse(state, task, fetched) {
  const finalKey = normalizeKey(fetched.finalUrl);
  const requestKey = normalizeKey(task.url);
  for (const redirect of fetched.redirects) {
    state.aliases.set(normalizeKey(redirect.from), finalKey);
  }
  if (requestKey !== finalKey) state.aliases.set(requestKey, finalKey);

  const existing = state.captured.get(finalKey);
  if (existing) return existing;

  const { response } = fetched;
  const accepted404 = task.special404 && response.status === 404;
  if (!response.ok && !accepted404) {
    throw new SnapshotError(`${fetched.finalUrl.href} returned HTTP ${response.status}.`, 'E_HTTP');
  }

  const { buffer, reservedBytes } = await readResponseBuffer(state, response, fetched.finalUrl);
  let reservationCommitted = false;
  try {
    const capturedWhileReading = state.captured.get(finalKey);
    if (capturedWhileReading) return capturedWhileReading;
    const contentType = response.headers.get('content-type') ?? '';
    const kind = contentKind(contentType, fetched.finalUrl, task.kind, buffer);
    const pageLike = kind === 'html' && task.kind === 'page';

    let outputPath;
    if (task.special404) {
      outputPath = '404.html';
      state.claimedOutputs.set('404.html', fetched.finalUrl.href);
    }
    else if (pageLike) outputPath = pageOutputPath(fetched.finalUrl, { seed: task.seed });
    else outputPath = assetOutputPath(fetched.finalUrl, state.primaryOrigins);
    if (!pageLike && !task.special404) {
      outputPath = addContentExtension(outputPath, contentType, kind);
    }
    if (!task.special404) {
      outputPath = ensureUniqueOutput(outputPath, fetched.finalUrl, state.claimedOutputs);
    }

    const record = {
      url: fetched.finalUrl.href,
      requestedUrl: new URL(task.url).href,
      outputPath,
      kind,
      contentType,
      status: response.status,
      bytes: buffer.byteLength,
      referrer: task.referrer ?? null,
    };
    state.records.push(record);
    state.captured.set(finalKey, record);
    state.inFlightBytes -= reservedBytes;
    state.totalBytes += buffer.byteLength;
    reservationCommitted = true;
    if (pageLike) state.pageCount += 1;
    else state.assetCount += 1;

    const targetPath = path.join(state.stageDirectory, ...outputPath.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buffer);

    if (!task.deferDiscovery) await discoverFromRecord(state, record, buffer);
    state.options.onProgress({
      type: 'captured',
      url: record.url,
      output: record.outputPath,
      kind: record.kind,
      status: record.status,
      bytes: record.bytes,
    });
    return record;
  } finally {
    if (!reservationCommitted) state.inFlightBytes -= reservedBytes;
  }
}

async function discoverFromRecord(state, record, buffer) {
  const decoder = textDecoderFor(record.contentType);
  const text = ['html', 'css', 'manifest', 'javascript'].includes(record.kind)
    ? decoder.decode(buffer)
    : null;
  if (text === null) return;

  const reference = (raw, relation, base = record.url) => {
    discoverReference(state, raw, relation, base, record);
    return raw;
  };
  const warn = (message) => addWarning(state, message, record.url);

  if (record.kind === 'html') {
    transformHtml(text, {
      pageUrl: record.url,
      reference,
      absolutize: (raw, base) => {
        recordLiveForm(state, raw, base, record.url);
        return raw;
      },
      phase: 'discover',
      warn,
    });
    findRuntimeDependencies(state, text, record.url);
  } else if (record.kind === 'css') {
    transformCss(text, { reference: (raw, relation) => reference(raw, relation), warn });
  } else if (record.kind === 'manifest') {
    transformManifest(text, { reference: (raw, relation) => reference(raw, relation), warn });
  } else if (record.kind === 'javascript') {
    await transformJavaScript(text, {
      reference: (raw, relation) => reference(raw, relation),
      warn,
    });
    findRuntimeDependencies(state, text, record.url);
  }
}

function discoverReference(state, raw, relation, base, record) {
  if (!raw || raw.startsWith('#')) return;
  const url = normalizeUrl(raw, base);
  if (!url) return;

  if (relation === 'page') {
    enqueue(state, { url, kind: 'page', relation, referrer: record.url });
    return;
  }
  if (relation === 'iframe') {
    if (state.primaryOrigins.has(url.origin)) {
      enqueue(state, { url, kind: 'page', relation, referrer: record.url });
    } else {
      state.skipped.push({ url: url.href, reason: 'external-iframe', referrer: record.url });
    }
    return;
  }
  enqueue(state, { url, kind: 'asset', relation, referrer: record.url });
}

function enqueue(state, task) {
  const url = normalizeUrl(task.url);
  if (!url) return false;
  const key = url.href;
  if (state.scheduled.has(key) || state.captured.has(key) || state.aliases.has(key)) return false;

  if (task.kind === 'page') {
    if (!state.primaryOrigins.has(url.origin)) {
      state.skipped.push({ url: url.href, reason: 'external-page', referrer: task.referrer ?? null });
      return false;
    }
    if (!task.special404 && isDynamicPage(url)) {
      state.skipped.push({ url: url.href, reason: 'dynamic-page', referrer: task.referrer ?? null });
      state.liveDependencies.add(url.href);
      return false;
    }
    if (!task.special404 && state.options.robots && state.robots && state.robotsOrigin === url.origin) {
      const allowed = state.robots.isAllowed(url.href, DEFAULT_USER_AGENT);
      if (allowed === false) {
        state.skipped.push({ url: url.href, reason: 'robots', referrer: task.referrer ?? null });
        return false;
      }
    }
    if (!task.special404 && state.scheduledPageCount >= state.options.maxPages) {
      state.skipped.push({ url: url.href, reason: 'max-pages', referrer: task.referrer ?? null });
      return false;
    }
    if (url.search) {
      const queryKey = `${url.origin}${url.pathname}`;
      const count = state.queryVariants.get(queryKey) ?? 0;
      if (count >= state.options.maxQueryVariants) {
        state.skipped.push({ url: url.href, reason: 'max-query-variants', referrer: task.referrer ?? null });
        return false;
      }
      state.queryVariants.set(queryKey, count + 1);
    }
  } else {
    if (!state.primaryOrigins.has(url.origin) && !state.options.externalAssets) {
      state.skipped.push({ url: url.href, reason: 'external-asset', referrer: task.referrer ?? null });
      return false;
    }
    if (state.scheduledAssetCount >= state.options.maxAssets) {
      state.skipped.push({ url: url.href, reason: 'max-assets', referrer: task.referrer ?? null });
      return false;
    }
  }

  state.scheduled.add(key);
  if (task.kind === 'page') state.scheduledPageCount += 1;
  else state.scheduledAssetCount += 1;
  state.queue.push({ ...task, url });
  return true;
}

async function drainQueue(state) {
  let cursor = 0;
  while (cursor < state.queue.length) {
    const batch = state.queue.slice(cursor, cursor + state.options.concurrency);
    cursor += batch.length;
    await Promise.all(batch.map((task) => processTask(state, task)));
  }
}

async function processTask(state, task) {
  const key = normalizeKey(task.url);
  if (state.captured.has(key) || state.aliases.has(key)) return;
  try {
    const fetched = await fetchWithRedirects(state, task.url, task.kind);
    await captureResponse(state, task, fetched);
  } catch (error) {
    throwIfAborted(state, error);
    const failure = {
      url: task.url.href,
      reason: error.code ?? 'E_FETCH',
      message: error.message,
      referrer: task.referrer ?? null,
    };
    state.failures.push(failure);
    state.options.onProgress({ type: 'failed', ...failure });
  }
}

async function loadRobots(state) {
  if (!state.options.robots && !state.options.sitemap) return;
  const robotsUrl = new URL('/robots.txt', state.siteUrl);
  try {
    const fetched = await fetchWithRedirects(state, robotsUrl, 'asset');
    if (!fetched.response.ok) return;
    const buffer = await readMetadataBody(state, fetched.response);
    const text = buffer.toString('utf8');
    state.robots = robotsParser(robotsUrl.href, text);
    state.robotsOrigin = robotsUrl.origin;
    for (const sitemap of state.robots.getSitemaps()) state.sitemapUrls.add(sitemap);
  } catch (error) {
    throwIfAborted(state, error);
    addWarning(state, `Could not read robots.txt: ${error.message}`, robotsUrl.href);
  }
}

async function readMetadataBody(state, response) {
  const limit = Math.min(state.options.maxResourceBytes, 10 * 1024 * 1024);
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new SnapshotError('Metadata file is too large.', 'E_SIZE');
  }
  return readBodyLimited(response, limit);
}

async function wordpressRestCandidates(state, seedHeaders, seedRecord) {
  const candidates = new Map();
  const add = (raw, advertised = false, base = state.siteUrl) => {
    const url = normalizeUrl(raw, base);
    if (!url || !state.primaryOrigins.has(url.origin)) return;
    const existing = candidates.get(url.href);
    candidates.set(url.href, {
      url,
      advertised: advertised || existing?.advertised || false,
    });
  };

  for (const raw of restApiLinksFromHeader(seedHeaders.get('link'))) add(raw, true);

  const seedPath = path.join(state.stageDirectory, ...seedRecord.outputPath.split('/'));
  const seedBuffer = await fs.readFile(seedPath);
  const $ = cheerio.load(textDecoderFor(seedRecord.contentType).decode(seedBuffer));
  const rawBase = $('base[href]').first().attr('href');
  const documentBase = rawBase ? normalizeUrl(rawBase, seedRecord.url) ?? seedRecord.url : seedRecord.url;
  $('link[rel][href]').each((_index, element) => {
    const relations = ($(element).attr('rel') ?? '').split(/\s+/);
    if (relations.some(isWordPressApiRelation)) {
      add($(element).attr('href'), true, documentBase);
    }
  });

  add(new URL('/wp-json/', state.siteUrl.origin));
  const plainPermalinkApi = new URL('/?rest_route=/', state.siteUrl.origin);
  if (!candidates.has(plainPermalinkApi.href)) {
    candidates.set(plainPermalinkApi.href, { url: plainPermalinkApi, advertised: false });
  }
  return [...candidates.values()];
}

async function verifyWordPress(state, seedHeaders, seedRecord) {
  const candidates = await wordpressRestCandidates(state, seedHeaders, seedRecord);
  for (const candidate of candidates) {
    try {
      const fetched = await fetchWithRedirects(state, candidate.url, 'metadata');
      const buffer = await readMetadataBody(state, fetched.response);
      let payload;
      try {
        payload = JSON.parse(textDecoderFor(
          fetched.response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        ).decode(buffer));
      } catch {
        continue;
      }

      if (fetched.response.ok && isWordPressRestIndex(payload)) {
        state.wordpressApiUrl = fetched.finalUrl.href;
        state.wordpressVerification = 'rest-api';
        return;
      }
      if (isProtectedWordPressRestResponse(
        payload,
        fetched.response.status,
        candidate.advertised,
      )) {
        state.wordpressApiUrl = fetched.finalUrl.href;
        state.wordpressVerification = 'protected-rest-api';
        return;
      }
    } catch (error) {
      throwIfAborted(state, error);
    }
  }

  throw new SnapshotError(
    `Could not confirm that ${state.siteUrl.origin} is a WordPress site through its REST API. `
      + 'Use --skip-wordpress-check if the site hides or disables the API.',
    'E_NOT_WORDPRESS',
  );
}

async function discoverSitemaps(state) {
  if (!state.options.sitemap) return;
  const origin = new URL(state.siteUrl.origin);
  const siteBase = new URL(state.siteUrl);
  siteBase.search = '';
  siteBase.hash = '';
  if (!siteBase.pathname.endsWith('/')) siteBase.pathname += '/';
  for (const candidate of [
    new URL('wp-sitemap.xml', siteBase),
    new URL('?sitemap=index', siteBase),
    new URL('/wp-sitemap.xml', origin),
    new URL('/?sitemap=index', origin),
    new URL('/sitemap.xml', origin),
    new URL('/sitemap_index.xml', origin),
  ]) {
    state.sitemapUrls.add(candidate.href);
  }

  const pending = [...state.sitemapUrls];
  const visited = new Set();
  while (pending.length > 0 && visited.size < 100) {
    const rawUrl = pending.shift();
    const url = normalizeUrl(rawUrl, state.siteUrl);
    if (!url || visited.has(url.href)) continue;
    visited.add(url.href);
    if (!state.primaryOrigins.has(url.origin)) {
      state.skipped.push({ url: url.href, reason: 'external-sitemap', referrer: null });
      continue;
    }

    try {
      const fetched = await fetchWithRedirects(state, url, 'asset');
      if (!fetched.response.ok) continue;
      let buffer = await readMetadataBody(state, fetched.response);
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        buffer = gunzipSync(buffer, {
          maxOutputLength: Math.min(state.options.maxResourceBytes, 10 * 1024 * 1024),
        });
      }
      const $ = cheerio.load(buffer.toString('utf8'), { xmlMode: true });

      if ($('sitemapindex').length > 0) {
        $('sitemapindex > sitemap > loc').each((_, node) => {
          const location = $(node).text().trim();
          if (location) pending.push(location);
        });
      } else {
        $('urlset > url > loc').each((_, node) => {
          const page = normalizeUrl($(node).text().trim(), fetched.finalUrl);
          if (page && state.primaryOrigins.has(page.origin)) {
            enqueue(state, { url: page, kind: 'page', relation: 'sitemap', referrer: fetched.finalUrl.href });
          }
        });
      }
    } catch (error) {
      throwIfAborted(state, error);
      addWarning(state, `Could not read sitemap: ${error.message}`, url.href);
    }
  }
}

async function rewriteCapturedFiles(state) {
  for (const record of state.records) {
    throwIfAborted(state);
    if (!['html', 'css', 'manifest', 'javascript'].includes(record.kind)) continue;
    const targetPath = path.join(state.stageDirectory, ...record.outputPath.split('/'));
    const source = await fs.readFile(targetPath);
    const text = textDecoderFor(record.contentType).decode(source);
    const warn = (message) => addWarning(state, message, record.url);
    const reference = (raw, relation, base = record.url) => rewriteReference(state, record, raw, relation, base);
    let rewritten;

    if (record.kind === 'html') {
      rewritten = transformHtml(text, {
        pageUrl: record.url,
        reference,
        absolutize: (raw, base) => absolutizeReference(state, raw, base, record.url),
        publicPageUrl: publicUrlForOutput(state.options.publicUrl, record.outputPath),
        phase: 'rewrite',
        warn,
      });
    } else if (record.kind === 'css') {
      rewritten = transformCss(text, {
        reference: (raw, relation) => reference(raw, relation),
        warn,
      });
    } else if (record.kind === 'manifest') {
      rewritten = transformManifest(text, {
        reference: (raw, relation) => reference(raw, relation),
        warn,
      });
    } else {
      rewritten = await transformJavaScript(text, {
        reference: (raw, relation) => reference(raw, relation),
        warn,
      });
    }

    await fs.writeFile(targetPath, rewritten, 'utf8');
    record.bytes = Buffer.byteLength(rewritten);
  }
  state.totalBytes = state.records.reduce((sum, record) => sum + record.bytes, 0);
}

function resolveCaptured(state, key) {
  const visited = new Set();
  let current = key;
  while (current && !visited.has(current)) {
    visited.add(current);
    const direct = state.captured.get(current);
    if (direct) return direct;
    current = state.aliases.get(current);
  }
  return null;
}

function rewriteReference(state, fromRecord, raw, relation, base) {
  if (!raw || raw.startsWith('#')) return raw;
  let resolved;
  try {
    resolved = new URL(raw, base);
  } catch {
    return raw;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return raw;
  const fragment = resolved.hash;
  resolved.hash = '';
  const normalized = normalizeUrl(resolved);
  const target = normalized ? resolveCaptured(state, normalized.href) : null;
  if (target) {
    const pageNavigation = target.kind === 'html' && (relation === 'page' || relation === 'iframe');
    const createReference = pageNavigation ? relativePageReference : relativeFileReference;
    return createReference(fromRecord.outputPath, target.outputPath, fragment);
  }

  if (state.primaryOrigins.has(resolved.origin) || relation === 'asset' || relation === 'stylesheet') {
    state.liveDependencies.add(resolved.href);
    return resolved.href;
  }
  return raw;
}

function absolutizeReference(state, raw, base, referrer) {
  try {
    const resolved = new URL(raw, base);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      state.liveDependencies.add(resolved.href);
      return resolved.href;
    }
  } catch {
    addWarning(state, `Could not resolve form action: ${raw}`, referrer);
  }
  return raw;
}

function recordLiveForm(state, raw, base, referrer) {
  absolutizeReference(state, raw, base, referrer);
}

function findRuntimeDependencies(state, text, referrer) {
  const patterns = [
    /(?:https?:)?\/\/[^\s"']+\/wp-json\//gi,
    /["'](\/[^"']*(?:wp-json|admin-ajax\.php|wp-comments-post\.php|wc-ajax)[^"']*)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      try {
        state.liveDependencies.add(new URL(raw, referrer).href);
      } catch {
        // Ignore strings which look like URLs but are not valid URLs.
      }
    }
  }
}

function addWarning(state, message, url = null) {
  if (!state.warnings.some((warning) => warning.message === message && warning.url === url)) {
    state.warnings.push({ message, url });
  }
}

async function writeSupportFiles(state) {
  await fs.writeFile(path.join(state.stageDirectory, '.nojekyll'), '');
  await fs.writeFile(path.join(state.stageDirectory, '.wp-snapshot-output'), `wp-snapshot@${VERSION}\n`, 'utf8');
  if (!state.options.report) return;
  const report = {
    generatedBy: `wp-snapshot@${VERSION}`,
    generatedAt: new Date().toISOString(),
    source: redactUrl(state.siteUrl.href),
    publicUrl: redactUrl(state.options.publicUrl),
    wordpress: {
      verification: state.wordpressVerification,
      restApi: redactUrl(state.wordpressApiUrl),
    },
    stats: {
      pages: state.pageCount,
      assets: state.assetCount,
      redirects: state.aliases.size,
      bytes: state.totalBytes,
      skipped: state.skipped.length,
      failures: state.failures.length,
      liveDependencies: state.liveDependencies.size,
    },
    resources: state.records.map((record) => serializableResource(record, true)),
    skipped: state.skipped.map(redactIssue),
    failures: state.failures.map(redactIssue),
    warnings: state.warnings.map(redactIssue),
    liveDependencies: [...state.liveDependencies].map(redactUrl).sort(),
  };
  await fs.writeFile(
    path.join(state.stageDirectory, 'wp-snapshot.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}

function buildResult(state) {
  return {
    outputDir: state.options.outputDir,
    sourceUrl: state.siteUrl.href,
    pages: state.pageCount,
    assets: state.assetCount,
    redirects: state.aliases.size,
    bytes: state.totalBytes,
    skipped: state.skipped,
    failures: state.failures,
    warnings: state.warnings,
    liveDependencies: [...state.liveDependencies].sort(),
    resources: state.records.map(serializableResource),
    reportPath: state.options.report ? path.join(state.options.outputDir, 'wp-snapshot.json') : null,
  };
}
