# Publishing

GhostWriter is prepared to publish as four public npm packages.

## Final package names

- `@ghostwriter/core`
- `@ghostwriter/mcp-server`
- `@ghostwriter/create-book`
- `@ghostwriter/astro-reader`

## Initial public version

- `0.1.0`

Keep the four packages aligned on the same initial release unless there is a strong reason to split versions later.

## Release order

1. `@ghostwriter/core`
2. `@ghostwriter/astro-reader`
3. `@ghostwriter/mcp-server`
4. `@ghostwriter/create-book`

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
2. Make sure that token can publish under `@ghostwriter`
3. Publish from GitHub by either:
   - creating a GitHub Release tagged `v0.1.0`, `v0.1.1`, and so on
   - running the `Publish npm packages` workflow manually

The publish workflow verifies the release tag on GitHub Release events, runs the full release checks, and then publishes packages in dependency order.

## Publish example

Publish in release order from the workspace root:

```bash
npm publish -w @ghostwriter/core --access public
npm publish -w @ghostwriter/astro-reader --access public
npm publish -w @ghostwriter/mcp-server --access public
npm publish -w @ghostwriter/create-book --access public
```

You can also use the root helper script locally:

```bash
npm run publish:all
```

## Notes

- `ghostwriter-reader-init` supports published installs and can also be driven locally from the workspace.
- `create-ghostwriter-book --with-reader` keeps using a local file dependency when run from this monorepo so the generated reader works immediately during development.
