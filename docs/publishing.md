# Publishing

Narrarium is prepared to publish as four public npm packages.

## Final package names

- `narrarium`
- `narrarium-mcp-server`
- `create-narrarium-book`
- `narrarium-astro-reader`

## Initial public version

- `0.1.0`

Keep the four packages aligned on the same initial release unless there is a strong reason to split versions later.

## Release order

1. `narrarium`
2. `narrarium-astro-reader`
3. `narrarium-mcp-server`
4. `create-narrarium-book`

The starter and reader depend on the published package names, so publish the lower-level packages first.

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
3. Publish from GitHub by either:
   - creating a GitHub Release tagged `v0.1.0`, `v0.1.1`, and so on
   - running the `Publish npm packages` workflow manually

The publish workflow verifies the release tag on GitHub Release events, runs the full release checks, and then publishes packages in dependency order.

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
npm publish -w narrarium-astro-reader --access public
npm publish -w narrarium-mcp-server --access public
npm publish -w create-narrarium-book --access public
```

You can also use the root helper script locally:

```bash
npm run publish:all
```

## Notes

- `narrarium-reader-init` supports published installs and can also be driven locally from the workspace.
- `create-narrarium-book --with-reader` keeps using a local file dependency when run from this monorepo so the generated reader works immediately during development.
