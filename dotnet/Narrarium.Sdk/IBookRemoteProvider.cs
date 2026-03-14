namespace Narrarium.Sdk;

public interface IBookRemoteProvider
{
    BookProviderKind Kind { get; }

    Task<BookSnapshot> LoadBookAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default);

    Task<BookPushResult> CommitAndPushAsync(
        BookConnectionProfile profile,
        BookSnapshot snapshot,
        BookWorkspace workspace,
        BookCommitRequest request,
        CancellationToken cancellationToken = default);
}
