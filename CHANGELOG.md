# Changelog

## 0.1.2 - 2026-08-24

- Keep captured directory-page links in trailing-slash form so nested relative links stay under the correct path on clean-URL hosts.
- Apply the same directory-page handling to captured iframes while leaving asset paths unchanged.

## 0.1.1 - 2026-08-24

- Expand the README with installation, CLI and API usage, WordPress verification, limitations, safety notes, and contribution instructions.
- Include repository, issue tracker, and homepage links in the npm package metadata.
- Stabilize the concurrent output-collision test.
- Update the GitHub Actions used by CI.

## 0.1.0 - 2026-08-24

- First release.
- Crawl public WordPress pages from HTML links, robots.txt, and WordPress sitemaps.
- Download same-origin and external page assets.
- Rewrite HTML, CSS, manifests, import maps, ES module imports, and responsive image references.
- Capture the WordPress 404 template and create a machine-readable report.
- Confirm the source through WordPress REST API discovery before crawling.
