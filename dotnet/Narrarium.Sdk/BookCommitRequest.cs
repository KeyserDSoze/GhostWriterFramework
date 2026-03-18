namespace Narrarium.Sdk;

public sealed record BookCommitRequest
{
    public required string Message { get; init; }

    public string? AuthorName { get; init; }

    public string? AuthorEmail { get; init; }
}
