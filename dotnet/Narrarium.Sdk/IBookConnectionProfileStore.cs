namespace Narrarium.Sdk;

public interface IBookConnectionProfileStore
{
    Task<IReadOnlyList<BookConnectionProfile>> ListAsync(CancellationToken cancellationToken = default);

    Task<BookConnectionProfile?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task<BookConnectionProfile> SaveAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default);

    Task<bool> DeleteAsync(string id, CancellationToken cancellationToken = default);
}
