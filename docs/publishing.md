# Publishing

Narrarium is prepared to publish as seven public npm packages.

## Final package names

- `narrarium`
- `narrarium-sdk`
- `narrarium-mcp-server`
- `create-narrarium-book`
- `narrarium-astro-reader`
- `narrarium-engine`
- `narrarium-server`

## Versioning note

- The public package line started at `0.1.0`.

The public packages use independent versions. Each package version is published and checked separately; dependency ranges must still resolve to the workspace versions in publication order.

## Release order

1. `narrarium`
2. `narrarium-engine`
3. `narrarium-sdk`
4. `narrarium-astro-reader`
5. `narrarium-mcp-server`
6. `create-narrarium-book`
7. `narrarium-server`

The starter, the reader and the personal server depend on the published package names, so publish the lower-level packages first. `narrarium-engine` depends on `narrarium`; `narrarium-server` depends on `narrarium-engine`.

## Dry run checks

From the workspace root:

```bash
npm run release:check
```

This runs:

- workspace build
- TypeScript validation
- automated package tests
- `npm pack --dry-run` for every public package

## GitHub Actions setup

The repository includes:

- `.github/workflows/ci.yml`
- `.github/workflows/publish-npm.yml`

To enable npm publishing from GitHub:

1. Add the repository secret `NPM_TOKEN`
2. Make sure `NPM_TOKEN` is an npm Automation token for the account that will publish these package names
3. Merge version bumps to `main`
4. Optionally use either fallback trigger when needed:
   - create a GitHub Release tagged `v0.1.0`, `v0.1.1`, and so on
   - run the `Publish npm packages` workflow manually

On pushes to `main`, the publish workflow checks npm first and only publishes workspace packages whose local version is not already present in the registry.
When unpublished versions are detected, it runs the full release checks and then publishes packages in dependency order.
On GitHub Release events it verifies an unambiguous package tag such as `vnarrarium@0.1.57` or `vcreate-narrarium-book@0.1.58`, checks the tagged package's workspace dependency ranges, and checks that dependencies occur earlier in the publication order. The old ambiguous `v0.1.58` form is rejected.

If GitHub Actions fails with `EOTP`, npm is rejecting the token for write operations with 2FA enabled. In that case either:

- replace `NPM_TOKEN` with an npm Automation token
- or configure npm Trusted Publishing for this GitHub repository instead of token-based publish auth

If GitHub Actions fails with `E404` while publishing `narrarium` or the other unscoped packages, npm is usually telling you that the package name is not available to the authenticated account or the registry request is wrong. In that case:

- make sure the package names are still free or already owned by the publishing account
- make sure the token belongs to the npm account you expect by checking `npm whoami`
- make sure the workflow is publishing to the public npm registry

## Publish example

Publish in release order from the workspace root:

```bash
npm publish -w narrarium --access public
npm publish -w narrarium-sdk --access public
npm publish -w narrarium-astro-reader --access public
npm publish -w narrarium-mcp-server --access public
npm publish -w create-narrarium-book --access public
```

You can also use the root helper script locally:

```bash
npm run publish:all
```

## Notes

- The default production flow is: bump versions, merge to `main`, and let GitHub Actions publish the packages that are not already on npm.
- `narrarium-reader-init` supports published installs and can also be driven locally from the workspace.
- `create-narrarium-book --with-reader` keeps using a local file dependency when run from this monorepo so the generated reader works immediately during development.
