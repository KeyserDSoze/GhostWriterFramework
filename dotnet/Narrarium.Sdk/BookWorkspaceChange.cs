namespace Narrarium.Sdk;

public enum BookWorkspaceChangeKind
{
    Upsert,
    Delete,
}

public sealed record BookWorkspaceChange
{
    public required BookWorkspaceChangeKind Kind { get; init; }

    public required string Path { get; init; }

    public NarrariumDocument? Document { get; init; }

    public string? RawMarkdown { get; init; }
}
