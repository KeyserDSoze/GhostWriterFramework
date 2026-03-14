# Narrarium .NET SDK

This folder contains the first .NET 10 foundation for the Narrarium SDK.

Current scope:

- `BookManager` as the facade for loading books, opening workspaces, and committing changes
- profile models for GitHub and Azure DevOps connections
- in-memory `BookSnapshot` and `BookWorkspace` models
- `IServiceCollection` extensions for DI registration
- pluggable `IBookConnectionProfileStore` so a Rystem-backed profile store can be registered later
- real GitHub and Azure DevOps remote providers for loading Narrarium repositories and pushing direct commits
- `Narrarium.Sdk.AspNetCore` for minimal API endpoint mapping and authorization policy helpers

Typical registration:

```csharp
services
    .AddNarrariumBookManager()
    .AddDefaultRemoteProviders();
```

If you want a custom persistent profile store:

```csharp
services
    .AddNarrariumBookManager()
    .AddNarrariumProfileStore<MyRystemBookConnectionProfileStore>()
    .AddDefaultRemoteProviders();
```

The built-in GitHub and Azure DevOps provider classes now implement remote HTTP load and direct push flows. The next step is adding richer high-level document mutation helpers and the Rystem-backed profile store.

Minimal API integration lives in `dotnet/Narrarium.Sdk.AspNetCore`. It adds `MapNarrariumEndpoints()` plus `AddNarrariumPolicies()` so a server can expose profile, load, and commit routes that a TypeScript client can call later.
