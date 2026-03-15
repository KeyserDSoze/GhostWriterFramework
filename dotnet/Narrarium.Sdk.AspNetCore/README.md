# Narrarium .NET AspNetCore

`Narrarium.Sdk.AspNetCore` adds minimal API endpoint mapping and authorization helpers on top of `Narrarium.Sdk`.

It is meant for server-side applications that want to expose the same book profile, load, and commit flows to a remote client such as the TypeScript SDK.

Mapped endpoints include:

- `/api/narrarium/profiles`
- `/api/narrarium/profiles/{profileId}/book`
- `/api/narrarium/profiles/{profileId}/git`
- `/api/narrarium/profiles/{profileId}/commit`
- `/api/narrarium/profiles/{profileId}/notes`
- `/api/narrarium/profiles/{profileId}/story-design`
- `/api/narrarium/profiles/{profileId}/chapters/{chapter}/notes`

## Typical setup

```csharp
builder.Services
    .AddNarrariumBookManager()
    .AddDefaultRemoteProviders();

builder.Services
    .AddAuthorizationBuilder()
    .AddNarrariumPolicies();

var app = builder.Build();

app.MapNarrariumEndpoints();
```

## Default authorization policies

- `Narrarium.Profiles`
- `Narrarium.Read`
- `Narrarium.Write`

Default scope values:

- `narrarium.profiles`
- `narrarium.read`
- `narrarium.write`

The policy helper checks `scope`, `scp`, and `permissions` claims by default.
