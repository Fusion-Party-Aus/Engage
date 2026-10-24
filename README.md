# Reclaim Platform

Standalone static export of the Reclaim policy platform, including the policy baseline used to structure its content.

## Contents

- `index.html` and route folders: generated static website pages
- `_astro/`: generated styles and image assets
- `policy-baseline.md`: source policy platform baseline
- `policy-baseline-style-rule.md`: drafting and style rules for the baseline

## Preview locally

Run a static file server from this directory, then open its local URL:

```sh
python3 -m http.server 8000
```

The generated pages use root-relative URLs, so serve this directory from the web server root.

## Updating the export

Copy the latest generated site output into the repository root, preserving the `_astro/` assets and route directory structure. Update the policy baseline files when their source changes.
