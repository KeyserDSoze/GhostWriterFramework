# Narrarium deployment routing

Narrarium is hosted on GitHub Pages and uses React Router's browser-history URLs.

## Supported contract

- Finite entry points such as `/`, `/app/`, `/app/books/`, `/app/patch-notes/`, `/login/`, `/docs/`, and every published `/docs/<slug>/` page have physical HTML files and return HTTP 200.
- Repository-derived deep links such as `/app/books/<book-id>/chapters/<chapter-id>` are unbounded and cannot have physical files generated ahead of time.
- GitHub Pages returns the shared `404.html` application shell for those dynamic paths. The initial origin status is therefore 404, but the shell keeps the original URL and React Router opens the requested book location.
- Once the PWA controls the page, its service worker serves the cached application shell for navigation requests, including dynamic deep links.

This is an intentional hosting tradeoff. A browser refresh retains the current dynamic location. HTTP monitors, link-preview crawlers, and clients that reject a 404 before running JavaScript will not treat dynamic routes as successful responses.

## Rejected alternatives

- Hash routing would change canonical and shared URLs to `/#/app/...`, complicate PWA navigation and OAuth fragments, and leave existing clean deep links returning 404.
- A true HTTP 200 for every clean dynamic route requires a host or edge layer with an unmatched-route rewrite to `/index.html`. The project has explicitly chosen to remain entirely on GitHub Pages.
- A JavaScript redirect in `404.html` cannot change the status of the initial response and adds an unnecessary navigation round trip.

If the hosting constraint changes, retain the clean BrowserRouter URLs and add a server-side SPA fallback rather than migrating to hash routing.
