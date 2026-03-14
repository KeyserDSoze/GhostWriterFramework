namespace Narrarium.Sdk;

public abstract record BookConnectionProfile
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string Branch { get; init; }

    public string? Ref { get; init; }

    public bool IsDefault { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    public abstract BookProviderKind Provider { get; }
}

public sealed record GitHubBookConnectionProfile : BookConnectionProfile
{
    public required string Owner { get; init; }

    public required string Repository { get; init; }

    public required string Token { get; init; }

    public override BookProviderKind Provider => BookProviderKind.GitHub;
}

public sealed record AzureDevOpsBookConnectionProfile : BookConnectionProfile
{
    public required string Organization { get; init; }

    public required string Project { get; init; }

    public required string Repository { get; init; }

    public required string Token { get; init; }

    public override BookProviderKind Provider => BookProviderKind.AzureDevOps;
}
