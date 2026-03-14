using System.Net;
using System.Text;
using System.Text.Json;

namespace Narrarium.Sdk.Tests;

internal sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly List<FakeResponse> _responses = [];

    public List<CapturedRequest> Requests { get; } = [];

    public void AddJson(HttpMethod method, string url, object body, HttpStatusCode statusCode = HttpStatusCode.OK)
    {
        _responses.Add(new FakeResponse(method, url, statusCode, JsonSerializer.Serialize(body), "application/json"));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        var url = request.RequestUri?.ToString() ?? string.Empty;
        Requests.Add(new CapturedRequest(request.Method, url, body));

        var match = _responses.FirstOrDefault(response => response.Method == request.Method && string.Equals(response.Url, url, StringComparison.Ordinal));
        if (match is null)
        {
            throw new InvalidOperationException($"No fake response registered for {request.Method} {url}.");
        }

        return new HttpResponseMessage(match.StatusCode)
        {
            Content = new StringContent(match.Body, Encoding.UTF8, match.ContentType),
        };
    }

    internal sealed record CapturedRequest(HttpMethod Method, string Url, string? Body);

    private sealed record FakeResponse(HttpMethod Method, string Url, HttpStatusCode StatusCode, string Body, string ContentType);
}
