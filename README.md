# wp-snapshot

`wp-snapshot` exports the public side of a WordPress site as static HTML and assets.

It does not need a WordPress plugin or an admin account. Before the export starts, it uses WordPress's public REST API discovery link and API index to confirm that the URL is really backed by WordPress. It then reads WordPress sitemaps, crawls the public HTML, downloads the assets, and changes captured links to relative file paths.

```bash
npx wp-snapshot https://example.com --output snapshot
```

The generated folder can be opened from disk or deployed under any URL path. A link such as `/about/` becomes a real relative file reference such as `./about/index.html`. Nested pages, CSS assets, query URLs, redirects, and fragments are handled in the same way.

## Install

Node.js 22.12 or newer is required.

```bash
npm install --global wp-snapshot
```

You can also run it without a global install:

```bash
npx wp-snapshot https://example.com
```

## Usage

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
```

`wp-snapshot` will not remove an existing non-empty output directory unless you pass `--clean`. Normal clean runs only replace folders created by an earlier `wp-snapshot` run. Use `--force-clean` for a different folder. Version-control roots, your home folder, the current folder, and its parents are always refused. The tool first writes into a temporary folder and replaces the target only after the snapshot is ready.

## WordPress verification

The check follows the [official WordPress REST API discovery method](https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/). It reads the `rel="https://api.w.org/"` HTTP or HTML link from the first page, then validates the advertised API index. If the page does not advertise one, it tries `/wp-json/` and the plain-permalink `?rest_route=/` form. A valid index must contain the core `wp/v2` namespace and routes.

`wp-admin` is not used for detection. A login redirect is not a reliable way to identify WordPress, and some sites hide or move it.

Some security plugins and firewalls disable the public REST API. If you already know the source is WordPress, bypass only this preflight check:

```bash
wp-snapshot https://wordpress.example --skip-wordpress-check
```

The library equivalent is `skipWordPressCheck: true`. The report records whether WordPress was verified through the REST API or the check was skipped.

## What it captures

- Posts, pages, archives, pagination, and other public HTML found in links or sitemaps
- Pretty permalinks and query permalinks such as `?p=42`
- The active WordPress 404 page as `404.html`
- Theme, plugin, upload, and WordPress core assets
- Images from `src`, `srcset`, and common lazy-loading attributes
- Stylesheets, nested CSS imports, fonts, CSS images, scripts, modules, icons, media, and web manifests
- External subresources such as CDN images and fonts when `--external-assets` is enabled, without crawling external websites
- Redirect aliases, fragments, `<base href>`, inline styles, import maps, and cache-busting query strings

The tool reads `robots.txt`, native `/wp-sitemap.xml`, plain-permalink `?sitemap=index`, and common sitemap locations. Use `--ignore-robots` only for a site you control.

Same-origin assets are always captured. External assets stay remote by default. Use `--external-assets` when you also want public CDN files, remote fonts, and other cross-origin subresources. Private and local network targets are blocked unless you also pass `--allow-private-network`.

## Static does not mean every WordPress feature works

The output contains static files. PHP and MySQL are not part of it.

Comments, search, login, preview links, forms, WooCommerce carts and checkout, admin AJAX, and REST-driven blocks still need a live server. `wp-snapshot` excludes known admin and dynamic crawl targets. It keeps form actions pointed at the source site and lists remaining live URLs in `wp-snapshot.json`.

Static ES module imports and string-based dynamic imports are captured and rewritten. Other JavaScript is copied without trying to change arbitrary strings inside the code. Calculated imports, worker URLs, and runtime API calls can still need the original WordPress site.

## Canonical URLs

By default, copied canonical and `og:url` tags are removed because the tool does not know where you will deploy the result. Pass the final public base URL to create correct deployment metadata:

```bash
wp-snapshot https://wordpress.example \
  --output dist \
  --public-url https://static.example/blog/
```

## Private or protected source sites

Repeat `--header` when the source needs a request header:

```bash
wp-snapshot https://staging.example \
  --header 'Authorization: Bearer example' \
  --header 'Cookie: wordpress_logged_in=example'
```

Authorization and cookie headers are never forwarded when an asset redirects to another origin. Headers are not written into the report.

## JavaScript API

The API is ESM-only.

```js
import { snapshot } from 'wp-snapshot';

const result = await snapshot({
  url: 'https://example.com',
  outputDir: './snapshot',
  clean: true,
});

console.log(result.pages, result.assets, result.outputDir);
```

The returned result includes captured resources, skipped URLs, failures, warnings, and live dependencies. TypeScript declarations are included.

## Report

Every run writes `wp-snapshot.json` inside the output folder. It includes:

- source and generated time
- WordPress verification method and discovered REST API root
- page, asset, redirect, and byte totals
- the source URL and local path for each captured resource
- skipped dynamic or out-of-scope URLs
- failed requests and parser warnings
- live URLs still used by forms or runtime code

Run with `--strict` when a failed discovered resource should stop the export. Run with `--no-report` if you do not want the report in the deployed folder.

## License

MIT
