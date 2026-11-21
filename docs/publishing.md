# Publishing

Narrarium is prepared to publish as seven public npm packages; six follow the release order below and `narrarium-server` has its own release workflow.

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

The starter and the reader depend on the published package names, so publish the lower-level packages first. `narrarium-engine` depends on `narrarium`.

`narrarium-server` is not part of this order: it bundles the engine into a self-contained package (no runtime dependencies) and is released separately, see below.

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
- `.github/workflows/server.yml`: personal server tests on Linux, Windows and macOS
- `.github/workflows/publish-server-npm.yml`: `narrarium-server` releases

Packages are published with **npm Trusted Publishing**: GitHub Actions proves its identity to npm through OIDC, so no npm token is stored, and every version carries a provenance attestation.

1. A package must already exist on npm before a trusted publisher can be registered. Publish the first version of a new package once by hand from a clean, built checkout (`npm ci`, `npm run build`, `npm login` with two-factor authentication, then `npm publish -w <package> --access public --provenance=false`).
2. On npmjs.com open the package **Settings → Trusted publishing** and add GitHub Actions: owner `KeyserDSoze`, repository `GhostWriterFramework`, workflow `publish-npm.yml`, environment `production`.
3. Merge version bumps to `main`. Optionally use either fallback trigger when needed:
   - create a GitHub Release tagged `vnarrarium@0.1.58`, `vcreate-narrarium-book@0.1.59`, and so on
   - run the `Publish npm packages` workflow manually

Until every package has its trusted publisher, the `NPM_TOKEN` secret is used as a fallback; delete it once they all do.

On pushes to `main`, the publish workflow checks npm first and only publishes workspace packages whose local version is not already present in the registry. It never creates a package: a package that is not on npm yet is skipped with a warning asking for its first manual publish.
When unpublished versions are detected, it runs the full release checks and then publishes packages in dependency order.
On GitHub Release events it verifies an unambiguous package tag such as `vnarrarium@0.1.57` or `vcreate-narrarium-book@0.1.58`, checks the tagged package's workspace dependency ranges, and checks that dependencies occur earlier in the publication order. The old ambiguous `v0.1.58` form is rejected.

If GitHub Actions fails with `E401`, `E403` or `EOTP`, the package has no trusted publisher for this workflow yet (or the fallback token cannot publish it): register the trusted publisher as described above.

If GitHub Actions fails with `E404` while publishing, npm is usually telling you that the package does not exist yet or is not available to the publishing identity: publish its first version by hand, then register the trusted publisher.

## The personal server (`narrarium-server`)

The personal server updates itself from npm and installs only releases that carry the provenance attestation of `publish-server-npm.yml`, so it is published only by that workflow, through npm Trusted Publishing (OIDC, no `NPM_TOKEN`):

1. Bump `version` in `packages/server/package.json` and `SERVER_VERSION` in `packages/server/src/version.ts`, commit and push.
2. Push the tag `narrarium-server-v<version>`, for example `git tag narrarium-server-v0.1.1 && git push origin narrarium-server-v0.1.1`.

The very first version (`0.1.0`) must be published by hand, because npm binds a Trusted Publisher only to an existing package; then configure the Trusted Publisher (repository `KeyserDSoze/GhostWriterFramework`, workflow `publish-server-npm.yml`, environment `npm-publish`). The exact steps are in the [`narrarium-server` README](../packages/server/README.md#maintainers-releasing).

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
