import path from 'node:path';
import { createHash } from 'node:crypto';

const DYNAMIC_PATHS = [
  /(?:^|\/)wp-admin(?:\/|$)/i,
  /(?:^|\/)wp-login\.php$/i,
  /(?:^|\/)wp-comments-post\.php$/i,
  /(?:^|\/)wp-cron\.php$/i,
  /(?:^|\/)xmlrpc\.php$/i,
  /(?:^|\/)wp-json(?:\/|$)/i,
  /\/trackback\/?$/i,
  /\/feed\/?$/i,
];

const DYNAMIC_QUERY_KEYS = new Set([
  '_wpnonce',
  'action',
  'add-to-cart',
  'customize_changeset_uuid',
  'customize_messenger_channel',
  'customize_theme',
  'doing_wp_cron',
  'elementor-preview',
  'embed',
  'feed',
  'preview',
  'preview_id',
  'preview_nonce',
  'replytocom',
  'rest_route',
  's',
  'wc-ajax',
]);

const TRACKING_QUERY_KEYS = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
]);

const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.css', '.csv', '.doc', '.docx', '.eot', '.gif', '.gz',
  '.ico', '.jpeg', '.jpg', '.js', '.json', '.m4a', '.m4v', '.map', '.mov',
  '.mp3', '.mp4', '.mpeg', '.ogg', '.ogv', '.otf', '.pdf', '.png', '.rar',
  '.svg', '.tar', '.tgz', '.tif', '.tiff', '.ts', '.ttf', '.txt', '.wav',
  '.webm', '.webmanifest', '.webp', '.woff', '.woff2', '.xls', '.xlsx',
  '.xml', '.zip',
]);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const directoryClaimsByOutputMap = new WeakMap();

export function normalizeUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password) return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_QUERY_KEYS.has(lower) || lower.startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url;
}

export function normalizeKey(input, base) {
  return normalizeUrl(input, base)?.href ?? null;
}

export function isDynamicPage(url) {
  if (DYNAMIC_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return true;
  }

  for (const key of url.searchParams.keys()) {
    if (DYNAMIC_QUERY_KEYS.has(key.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export function isLikelyAsset(url) {
  return ASSET_EXTENSIONS.has(path.posix.extname(url.pathname).toLowerCase());
}

export function shortHash(value, length = 10) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function safeSegment(segment) {
  let value = segment
    .replaceAll('\\', '%5C')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '-')
    .replace(/\s+$/g, '');

  if (value === '' || value === '.' || value === '..') {
    value = `_${shortHash(segment, 8)}`;
  }
  if (WINDOWS_RESERVED.test(value)) {
    value = `_${value}`;
  }
  if (value.length > 120) {
    value = `${value.slice(0, 100)}~${shortHash(value, 12)}`;
  }
  return value;
}

function safePathSegments(url) {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map(safeSegment);
}

function querySlug(url) {
  if (!url.search) return null;
  const readable = [...url.searchParams]
    .slice(0, 3)
    .map(([key, value]) => `${safeSegment(key)}-${safeSegment(value || 'yes')}`)
    .join('_')
    .slice(0, 80);
  return `${readable || 'query'}~${shortHash(url.search, 10)}`;
}

export function pageOutputPath(url, { seed = false } = {}) {
  if (seed) return 'index.html';

  const segments = safePathSegments(url);
  const query = querySlug(url);
  if (query) {
    return path.posix.join(...segments, '_wp_query', query, 'index.html');
  }

  if (segments.length === 0) return 'index.html';
  const last = segments.at(-1);
  if (/\.html?$/i.test(last)) return path.posix.join(...segments);
  return path.posix.join(...segments, 'index.html');
}

export function assetOutputPath(url, primaryOrigins) {
  const segments = safePathSegments(url);
  let result = segments.length > 0 ? path.posix.join(...segments) : 'asset';

  if (url.pathname.endsWith('/')) {
    result = path.posix.join(result, 'asset');
  }

  if (url.search) {
    const extension = path.posix.extname(result);
    const stem = extension ? result.slice(0, -extension.length) : result;
    result = `${stem}~${shortHash(url.search, 10)}${extension}`;
  }

  if (!primaryOrigins.has(url.origin)) {
    result = path.posix.join('_wp_snapshot', 'external', safeSegment(url.host), result);
  }

  return result;
}

export function ensureUniqueOutput(candidate, url, claimedOutputs) {
  const suffix = shortHash(url.href, 10);
  let directoryClaims = directoryClaimsByOutputMap.get(claimedOutputs);
  if (!directoryClaims) {
    directoryClaims = new Map();
    directoryClaimsByOutputMap.set(claimedOutputs, directoryClaims);
  }
  let result = candidate;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const normalized = result.toLowerCase();
    const exactOwner = claimedOutputs.get(normalized);
    if (exactOwner === url.href) return result;

    const resultParts = result.split('/');
    let casingConflictIndex = -1;
    for (let index = 1; index < resultParts.length; index += 1) {
      const directory = resultParts.slice(0, index).join('/');
      const claimedDirectory = directoryClaims.get(directory.toLowerCase());
      if (claimedDirectory && claimedDirectory !== directory) {
        casingConflictIndex = index - 1;
        break;
      }
    }

    let conflictingPrefix = null;
    if (casingConflictIndex < 0) {
      for (const [claimed, owner] of claimedOutputs) {
        if (owner === url.href) continue;
        if (normalized === claimed || normalized.startsWith(`${claimed}/`) || claimed.startsWith(`${normalized}/`)) {
          conflictingPrefix = claimed;
          break;
        }
      }
    }

    if (!conflictingPrefix && casingConflictIndex < 0) {
      claimedOutputs.set(normalized, url.href);
      for (let index = 1; index < resultParts.length; index += 1) {
        const directory = resultParts.slice(0, index).join('/');
        directoryClaims.set(directory.toLowerCase(), directory);
      }
      return result;
    }

    const claimedParts = conflictingPrefix?.split('/') ?? [];
    const conflictIndex = casingConflictIndex >= 0
      ? casingConflictIndex
      : normalized.startsWith(`${conflictingPrefix}/`)
        ? claimedParts.length - 1
        : resultParts.length - 1;
    const value = resultParts[conflictIndex];
    const extension = path.posix.extname(value);
    const stem = extension ? value.slice(0, -extension.length) : value;
    resultParts[conflictIndex] = `${stem}~${suffix}${attempt || ''}${extension}`;
    result = resultParts.join('/');
  }

  throw new Error(`Could not create a unique output path for ${url.href}`);
}

export function relativeFileReference(fromOutput, toOutput, fragment = '') {
  if (fromOutput === toOutput && fragment) return fragment;
  let relative = path.posix.relative(path.posix.dirname(fromOutput), toOutput);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return `${relative || './index.html'}${fragment}`;
}

export function relativePageReference(fromOutput, toOutput, fragment = '') {
  if (fromOutput === toOutput && fragment) return fragment;

  const directoryIndex = toOutput === 'index.html'
    ? '.'
    : toOutput.endsWith('/index.html')
      ? toOutput.slice(0, -'/index.html'.length)
      : null;

  if (directoryIndex === null) {
    return relativeFileReference(fromOutput, toOutput, fragment);
  }

  let relative = path.posix.relative(path.posix.dirname(fromOutput), directoryIndex);
  if (relative === '') relative = './';
  else {
    if (!relative.startsWith('.')) relative = `./${relative}`;
    if (!relative.endsWith('/')) relative = `${relative}/`;
  }
  return `${relative}${fragment}`;
}

export function isInsideDirectory(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export const internal = {
  ASSET_EXTENSIONS,
  DYNAMIC_PATHS,
  DYNAMIC_QUERY_KEYS,
};
