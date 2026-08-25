# Dependency security policy

Narrarium treats the root lockfile and every workspace manifest as one supply-chain surface. CI runs `npm audit --audit-level=info` after a clean install, and `npm run dependency:check` also enforces direct-dependency and chunk-policy invariants.

The workspace pins npm `12.0.2`. npm 11 can install Sharp's non-host WASM fallbacks as orphaned packages on Linux; npm 12 produces the intended lockfile tree, and the gate runs `npm ls --depth=0` to reject actual extraneous packages.

## 0.76.93 disposition

The audit was reduced from 13 vulnerable package entries (9 high, 4 moderate) to zero production and development advisories.

### Removed direct dependencies

- `@azure/openai`: no runtime imports. Azure OpenAI support continues through the supported `openai` package and its `AzureOpenAI` client.
- `mammoth`: no runtime imports. Bounded DOCX extraction uses the existing ZIP/XML implementation.
- `@radix-ui/react-collapsible` and `@radix-ui/react-tooltip`: no source imports or wrappers.
- `fast-glob`: moved out of the browser site's runtime dependencies because that workspace uses it only for docs generation and tests. It remains a required runtime dependency of the Node.js `narrarium` core for repository scanning.

The lockfile no longer retains the Azure REST stack or Mammoth-only XML, promise, parser and utility packages.

### Fixed compatible updates

- PostCSS `8.5.26`, nanoid `3.3.18` and `5.1.16`, and brace-expansion `2.1.4` resolve the build-time and transitive advisories.
- Astro `7.2.6` resolves the Astro, Sharp, SVGO and js-yaml advisories in the static reader workspace.
- Model Context Protocol SDK `1.30.0` resolves the Hono adapter/runtime, URI and IP parsing advisory chains used by the MCP workspace.
- React Router `7.18.2` resolves the client-navigation open-redirect advisory and the SSR hydration advisory. Narrarium remains a client-only BrowserRouter application, but the major migration removes both advisory records rather than relying only on reachability.

Astro 7 requires Node.js `>=22.12.0`; both the published reader and its default scaffold CLI declare that engine floor.

### Chunk policy

Manual chunk rules exist only for packages that produce actual, stable boundaries: React/framework, Octokit, JSZip and OpenAI. Obsolete PDF.js, Mammoth and Azure OpenAI rules are forbidden by `scripts/check-dependency-policy.mjs`.

## Update policy

- Do not run broad `npm audit fix` without reviewing the manifest and lockfile diff.
- Prefer the smallest compatible security update first.
- Major migrations require typecheck, production build, route-family E2E, GitHub Pages basename E2E and PWA/offline checks.
- A dependency may remain temporarily only with a documented reachability analysis, owner and follow-up issue. The current audit has no such exception.
