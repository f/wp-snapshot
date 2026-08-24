# wp-snapshot

[![CI](https://github.com/f/wp-snapshot/actions/workflows/ci.yml/badge.svg)](https://github.com/f/wp-snapshot/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/wp-snapshot.svg)](https://www.npmjs.com/package/wp-snapshot)
[![Node.js](https://img.shields.io/node/v/wp-snapshot.svg)](https://www.npmjs.com/package/wp-snapshot)
[![MIT License](https://img.shields.io/npm/l/wp-snapshot.svg)](LICENSE)

Export a public WordPress site as static HTML, CSS, JavaScript, images, fonts, and other assets. Captured links are rewritten to relative file paths, so the output can be deployed at a domain root or under a subpath on a static host.

```bash
npx wp-snapshot https://example.com --output snapshot
```

No WordPress plugin or admin account is required. By default, `wp-snapshot` checks for WordPress through its REST API before it starts crawling. Pages are discovered from fetched, server-rendered HTML and sitemaps. The REST API is used only for preflight verification.

> `wp-snapshot` is at an early `0.1.x` release. Check the generated site before switching production traffic to it.

## Quick start

Node.js 22.12 or newer is required.

```bash
npx wp-snapshot https://example.com --output snapshot
```

Test the result through a local HTTP server:

```bash
npx http-server snapshot -a 127.0.0.1 -p 3000 -c-1 -d false
```

Then deploy the `snapshot/` directory to your static host.

## How it works

1. Check the WordPress REST API discovery link and core `wp/v2` routes.
2. Read `robots.txt`, WordPress sitemaps, and links in fetched HTML.
3. Download discovered pages and assets within the configured limits.
4. Rewrite captured HTML, CSS, manifest, import-map, and module references.
5. Write everything into a temporary directory first.
6. Replace the output directory only after the snapshot is ready.

`wp-snapshot` is an HTTP crawler. It parses HTML but does not open a browser or execute page JavaScript.

## Installation

Run the CLI without installing it globally:

```bash
npx wp-snapshot https://example.com
```

Or install the command globally:

```bash
npm install --global wp-snapshot
wp-snapshot https://example.com
```

Install it in a Node.js project to use the JavaScript API:

```bash
npm install wp-snapshot
```

## CLI usage

```text
wp-snapshot <url> [options]

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
-h, --help                    Show help
-v, --version                 Show the version
```

Run `wp-snapshot --help` to check the options supported by your installed version.

## Common examples

### Replace a previous snapshot

```bash
wp-snapshot https://example.com --output snapshot --clean
```

Normal `--clean` runs replace only directories created by an earlier `wp-snapshot` run. Use `--force-clean` when you intentionally want to replace a different directory. Git repositories, your home directory, the current directory, and its parents are always refused.

### Set the final deployment URL

By default, copied canonical and `og:url` tags are removed because the deployment URL is unknown. Pass the final public base URL to write the correct metadata:

```bash
wp-snapshot https://wordpress.example \
  --output dist \
  --public-url https://static.example/blog/
```

### Download public CDN assets

Cross-origin assets stay remote by default. Download public CDN images, fonts, and other subresources with:

```bash
wp-snapshot https://example.com --external-assets
```

External pages are not crawled. Private and local cross-origin targets are still blocked unless `--allow-private-network` is also passed.

### Read a protected source site

Repeat `--header` when a staging site needs a request header:

```bash
wp-snapshot https://staging.example \
  --header 'Authorization: Bearer example' \
  --header 'Cookie: wordpress_logged_in=example'
```

`Authorization`, `Cookie`, `Proxy-Authorization`, `X-API-Key`, and `X-Auth-Token` headers are removed after a request leaves the source origin. Header values are not written into the report.

Command-line secrets may remain in shell history. Use a temporary shell session or another safe method for real credentials.

## Output

A typical result looks like this:

```text
snapshot/
├── index.html
├── about/
│   └── index.html
├── 404.html
├── wp-content/
│   └── ...
├── .nojekyll
├── .wp-snapshot-output
└── wp-snapshot.json
```

Captured page links use relative directory URLs. For example, `/about/` can become `./about/`. Asset links continue to use relative file paths. The `.wp-snapshot-output` marker protects future `--clean` runs.

Use an HTTP server when testing. The command above redirects real directories to their trailing-slash URLs without changing extensionless asset paths. Keep the trailing slash on directory page URLs, such as `/about/`, so nested relative links resolve from the correct directory.

## WordPress verification

The preflight follows the [official WordPress REST API discovery method](https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/).

It checks, in order:

1. The `rel="https://api.w.org/"` HTTP `Link` header.
2. The matching HTML `<link>` element.
3. The standard `/wp-json/` API root.
4. The plain-permalink `?rest_route=/` API root.

The returned index must contain the core `wp/v2` namespace and routes. An advertised API root returning a WordPress-shaped `rest_*` 401 or 403 response is also accepted as a protected WordPress site.

`wp-admin` is not used for detection. A login path or redirect is not a reliable WordPress signal.

If a security plugin or firewall hides the REST API, and you already know the source is WordPress, skip only this check:

```bash
wp-snapshot https://wordpress.example --skip-wordpress-check
```

An unverified source fails with `E_NOT_WORDPRESS` before robots, sitemaps, linked pages, or assets are crawled.

## What it captures

- Server-rendered posts, pages, archives, and pagination found in links or sitemaps
- Pretty permalinks and query permalinks such as `?p=42`
- A usable WordPress 404 response as `404.html`, when available
- Discovered theme, plugin, upload, and WordPress core assets
- Images from `src`, `srcset`, and common lazy-loading attributes
- Stylesheets, nested CSS imports, fonts, CSS images, scripts, icons, media, and web manifests
- Import maps plus URL-like static and string-based dynamic ES module imports
- Redirect destinations, fragments, `<base href>`, inline styles, and cache-busting query strings
- Public cross-origin subresources when `--external-assets` is enabled

The crawler reads native `/wp-sitemap.xml`, plain-permalink `?sitemap=index`, sitemap URLs from `robots.txt`, and common sitemap plugin locations. Discovered same-origin assets are captured within the configured asset and byte limits.

## Limitations

The output contains static files. PHP and MySQL are not copied.

- Comments, search, login, preview links, and forms still need a live server.
- WooCommerce carts, checkout, and other session-based features remain dynamic.
- Admin AJAX and REST-driven blocks can still depend on the original site.
- Content rendered only after browser JavaScript runs is not discovered automatically.
- Calculated imports, worker URLs, service workers, and runtime API calls may need manual work.
- Bare package imports such as `react` are not rewritten.
- Cross-origin resources remain live unless `--external-assets` captures them.
- A redirect is followed and discovered links point to the final file, but no static redirect rule or alias file is created.

Known dynamic and admin URLs are not crawled. Form actions stay pointed at the source. Remaining live URLs are listed in `wp-snapshot.json`.

## Output and network safety

- `robots.txt` rules are applied to discovered same-origin pages by default.
- External asset capture is opt-in.
- Private-network cross-origin requests are blocked by default.
- Individual and total response sizes have limits.
- Recognized credential-like query parameters are redacted from the deployable report.
- Abort signals remove staging output instead of committing a partial snapshot.
- Output paths are protected against file, directory, prefix, and case-folding collisions.

With `--strict`, crawling completes but the export fails and staged output is not committed if a discovered request failed. Parser warnings and intentionally skipped resources do not trigger strict failure.

## JavaScript API

The API is ESM-only and includes TypeScript declarations.

```js
import { snapshot, SnapshotError } from 'wp-snapshot';

try {
  const result = await snapshot({
    url: 'https://example.com',
    outputDir: './snapshot',
    clean: true,
    publicUrl: 'https://static.example/blog/',
  });

  console.log(result.pages, result.assets, result.outputDir);
} catch (error) {
  if (error instanceof SnapshotError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

The result includes captured resources, skipped URLs, failures, warnings, live dependencies, byte totals, redirect totals, and the report path.

The library exposes the snapshot behavior used by the CLI, plus a few lower-level options:

| Option | Default | Purpose |
| --- | ---: | --- |
| `maxQueryVariants` | `25` | Limit query variants for one path |
| `maxResourceBytes` | `50 MiB` | Limit one captured response |
| `maxTotalBytes` | `1 GiB` | Limit the complete snapshot |
| `maxRedirects` | `10` | Limit redirects for one request |
| `signal` | none | Cancel with an `AbortSignal` |
| `onProgress` | no-op | Receive capture and failure events |

See [`src/index.d.ts`](src/index.d.ts) for the complete API contract.

## Report

By default, every successful run writes `wp-snapshot.json` inside the output directory. It includes:

- source URL, deployment URL, and generation time
- WordPress verification method and discovered REST API root
- page, asset, redirect, failure, skip, and byte totals
- source URL and local path for each captured resource
- skipped and failed requests
- parser warnings
- remaining live dependencies

Use `--no-report` when you do not want the report in the deployed directory.

## Development

```bash
git clone https://github.com/f/wp-snapshot.git
cd wp-snapshot
npm ci
npm run verify
```

`npm run verify` runs the behavior and integration tests, then checks JavaScript syntax, package metadata, ESM types, and the packed npm artifact. Use `npm test` for a faster test-only run while working.

## Contributing

Issues and pull requests are welcome.

- Open an [issue](https://github.com/f/wp-snapshot/issues) for bugs, edge cases, or larger changes.
- Add a focused test when changing crawling, URL mapping, rewriting, or safety behavior.
- Run `npm run verify` before opening a pull request.
- Do not commit generated snapshots, credentials, or private source URLs.

Please keep bug reports reproducible. If the source site is private, create a small local fixture instead of posting access details.

## Project links

- [npm package](https://www.npmjs.com/package/wp-snapshot)
- [Issue tracker](https://github.com/f/wp-snapshot/issues)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © fka.dev
