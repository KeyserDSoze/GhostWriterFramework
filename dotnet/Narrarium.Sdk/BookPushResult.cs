namespace Narrarium.Sdk;

public sealed record BookPushResult
{
    public required string ProfileId { get; init; }

    public required BookProviderKind Provider { get; init; }

    public required string Branch { get; init; }

    public required string PreviousCommitSha { get; init; }

    public required string CommitSha { get; init; }

    public required DateTimeOffset PushedAt { get; init; }

    public IReadOnlyList<string> ChangedPaths { get; init; } = Array.Empty<string>();

    public required string Message { get; init; }
}
