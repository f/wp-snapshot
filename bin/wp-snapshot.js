#!/usr/bin/env node

import { parseArgs } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { snapshot, SnapshotError } from '../src/index.js';
import { VERSION } from '../src/version.js';

const HELP = `wp-snapshot ${VERSION}

Export a public WordPress site as static HTML and assets.

Usage:
  wp-snapshot <url> [options]

Options:
  -o, --output <directory>       Output directory (default: snapshot)
      --clean                    Replace a non-empty output directory
      --force-clean              Replace a non-snapshot output directory
      --concurrency <number>     Concurrent requests (default: 8)
      --max-pages <number>       Maximum public pages (default: 1000)
      --max-assets <number>      Maximum assets (default: 5000)
      --timeout <milliseconds>   Per-request timeout (default: 30000)
      --header <name:value>      Request header; can be repeated
      --public-url <url>         Deployment URL for canonical metadata
      --no-sitemap              Do not discover WordPress sitemaps
      --ignore-robots           Ignore robots.txt crawl rules
      --no-404                  Do not capture the WordPress 404 template
      --skip-wordpress-check    Skip WordPress REST API verification
      --external-assets         Download public CDN and other external assets
      --allow-private-network   Allow external assets on private IP ranges
      --strict                  Fail if any discovered resource fails
      --no-report               Do not write wp-snapshot.json
      --verbose                 Print every captured resource
      --quiet                   Print only errors
  -h, --help                    Show this help
  -v, --version                 Show the version

Examples:
  wp-snapshot https://example.com
  wp-snapshot https://example.com -o dist --clean
  wp-snapshot http://localhost:8080 -o dist --ignore-robots
`;

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new SnapshotError(`${name} must be a positive integer.`, 'E_OPTION');
  }
  return number;
}

function parseHeaders(values = []) {
  const headers = new Headers();
  for (const value of values) {
    const separator = value.indexOf(':');
    if (separator < 1 || /[\r\n]/.test(value)) {
      throw new SnapshotError(`Invalid header: ${value}`, 'E_OPTION');
    }
    headers.append(value.slice(0, separator).trim(), value.slice(separator + 1).trim());
  }
  return headers;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        clean: { type: 'boolean' },
        'force-clean': { type: 'boolean' },
        concurrency: { type: 'string' },
        'max-pages': { type: 'string' },
        'max-assets': { type: 'string' },
        timeout: { type: 'string' },
        header: { type: 'string', multiple: true },
        'public-url': { type: 'string' },
        'no-sitemap': { type: 'boolean' },
        'ignore-robots': { type: 'boolean' },
        'no-404': { type: 'boolean' },
        'skip-wordpress-check': { type: 'boolean' },
        'external-assets': { type: 'boolean' },
        'allow-private-network': { type: 'boolean' },
        strict: { type: 'boolean' },
        'no-report': { type: 'boolean' },
        verbose: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\nRun wp-snapshot --help for usage.\n`);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (positionals.length !== 1) {
    process.stderr.write('Provide one WordPress URL.\nRun wp-snapshot --help for usage.\n');
    process.exitCode = 1;
    return;
  }
  if (values.quiet && values.verbose) {
    process.stderr.write('Use either --quiet or --verbose, not both.\n');
    process.exitCode = 1;
    return;
  }

  const abortController = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    abortController.abort(new Error('Interrupted'));
  };
  process.on('SIGINT', interrupt);

  try {
    const outputDir = path.resolve(values.output ?? 'snapshot');
    if (!values.quiet) process.stdout.write(`Snapshotting ${positionals[0]}\n`);
    const result = await snapshot({
      url: positionals[0],
      outputDir,
      clean: values.clean ?? false,
      forceClean: values['force-clean'] ?? false,
      concurrency: positiveInteger(values.concurrency ?? 8, 'concurrency'),
      maxPages: positiveInteger(values['max-pages'] ?? 1000, 'max-pages'),
      maxAssets: positiveInteger(values['max-assets'] ?? 5000, 'max-assets'),
      timeout: positiveInteger(values.timeout ?? 30_000, 'timeout'),
      headers: parseHeaders(values.header),
      publicUrl: values['public-url'] ?? null,
      sitemap: !values['no-sitemap'],
      robots: !values['ignore-robots'],
      capture404: !values['no-404'],
      skipWordPressCheck: values['skip-wordpress-check'] ?? false,
      externalAssets: values['external-assets'] ?? false,
      allowPrivateNetwork: values['allow-private-network'] ?? false,
      strict: values.strict ?? false,
      report: !values['no-report'],
      signal: abortController.signal,
      onProgress: values.verbose
        ? (progress) => {
          if (progress.type === 'captured') {
            process.stdout.write(`  ${progress.status} ${progress.url} -> ${progress.output}\n`);
          } else {
            process.stderr.write(`  failed ${progress.url}: ${progress.message}\n`);
          }
        }
        : undefined,
    });

    if (!values.quiet) {
      process.stdout.write(
        `Saved ${result.pages} page${result.pages === 1 ? '' : 's'} and ` +
        `${result.assets} asset${result.assets === 1 ? '' : 's'} ` +
        `(${formatBytes(result.bytes)}) to ${result.outputDir}\n`,
      );
      if (result.failures.length > 0) {
        process.stdout.write(`Warning: ${result.failures.length} resource request${result.failures.length === 1 ? '' : 's'} failed.\n`);
      }
      if (result.liveDependencies.length > 0) {
        process.stdout.write(`Note: ${result.liveDependencies.length} live dependenc${result.liveDependencies.length === 1 ? 'y remains' : 'ies remain'}. See wp-snapshot.json.\n`);
      }
    }
  } catch (error) {
    const prefix = error instanceof SnapshotError && error.code ? `${error.code}: ` : '';
    process.stderr.write(`${prefix}${error.message}\n`);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    process.off('SIGINT', interrupt);
  }
}

await main();
