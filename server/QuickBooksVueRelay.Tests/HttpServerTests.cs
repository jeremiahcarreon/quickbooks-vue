using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QuickBooksVueRelay.Tests;

/// <summary>Stand-in for QbWorker: records what reached "QuickBooks".</summary>
internal sealed class FakeQb : IQbProcessor
{
    public List<(string Xml, string RequestId)> Received { get; } = new();
    public Func<string, Task<string>> Handler { get; set; } = xml => Task.FromResult(
        "<?xml version=\"1.0\" ?><QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode=\"0\" statusSeverity=\"Info\" statusMessage=\"Status OK\"/></QBXMLMsgsRs></QBXML>");
    public int RestartCount;

    public Task<string> ProcessRequestAsync(string qbXml, string requestId)
    {
        lock (Received) Received.Add((qbXml, requestId));
        return Handler(qbXml);
    }

    public void Restart() => Interlocked.Increment(ref RestartCount);
    public bool IsConnected { get; set; } = true;
    public bool IsRunning { get; set; } = true;
    public string? LastError { get; set; }
    public DateTime? LastErrorTime { get; set; }
    public DateTime LastRequestTime { get; set; } = DateTime.MinValue;
    public int QueueDepth { get; set; }
    public bool IsBusy { get; set; }
    public QbHostInfo? HostInfo { get; set; }
    public int Restarts => RestartCount;
    public string GetRecentErrors(int maxBytes = 20000) => "[2026-11-17T00:00:00Z] [FATAL] example\n";
}

public sealed class HttpServerTests : IAsyncLifetime
{
    private const string Key = "test-key-123";
    private const string ValidXml =
        "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
        "<CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>";
    private const string InvalidXml =
        "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
        "<CustomerQueryRq><Bogus/></CustomerQueryRq></QBXMLMsgsRq></QBXML>";

    private readonly FakeQb _qb = new();
    private readonly List<RelayHttpServer> _servers = new();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        foreach (var s in _servers) await s.DisposeAsync();
        _http.Dispose();
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private (string BaseUrl, RelayStats Stats) Start(
        SchemaValidationMode mode = SchemaValidationMode.Enforce,
        string apiKey = Key,
        string[]? allowed = null,
        long maxBody = RelayOptions.DefaultMaxRequestBodyBytes,
        int timeoutSeconds = 5,
        string? schemaDir = null,
        string schemaFile = TestSchemas.MiniEntry)
    {
        var port = FreePort();
        var options = new RelayOptions
        {
            Port = port,
            ApiKey = apiKey,
            AllowedIPs = allowed ?? Array.Empty<string>(),
            ValidateSchema = mode,
            SchemaDir = schemaDir ?? TestSchemas.MiniDir,
            SchemaFile = schemaFile,
            MaxRequestBodyBytes = maxBody,
            RequestTimeoutSeconds = timeoutSeconds,
        };
        var stats = new RelayStats();
        var server = new RelayHttpServer(options, _qb, SchemaValidationService.Create(options), stats, NullLogger.Instance, "9.9.9-test");
        server.Start($"http://127.0.0.1:{port}/");
        _servers.Add(server);
        return ($"http://127.0.0.1:{port}", stats);
    }

    private async Task<HttpResponseMessage> Post(string baseUrl, string qbxml, string? key = Key, string? requestId = null)
    {
        var msg = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/qb/request")
        {
            Content = JsonContent.Create(new { qbxml }),
        };
        if (key != null) msg.Headers.Add("X-Api-Key", key);
        if (requestId != null) msg.Headers.Add("X-Request-Id", requestId);
        return await _http.SendAsync(msg);
    }

    private static async Task<JsonElement> Json(HttpResponseMessage res) =>
        JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;

    [Fact]
    public async Task Valid_request_is_forwarded_and_response_returned()
    {
        var (url, stats) = Start();
        var res = await Post(url, ValidXml, requestId: "abc-1");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await Json(res);
        Assert.Contains("CustomerQueryRs", body.GetProperty("response").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal("abc-1", res.Headers.GetValues("X-Request-Id").Single());
        var sent = Assert.Single(_qb.Received);
        Assert.Equal(ValidXml, sent.Xml);
        Assert.Equal("abc-1", sent.RequestId);
        Assert.Equal(1, stats.Succeeded);
    }

    [Fact]
    public async Task Enforce_mode_rejects_invalid_qbxml_with_400_and_never_forwards_it()
    {
        var (url, stats) = Start(SchemaValidationMode.Enforce);
        var res = await Post(url, InvalidXml);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await Json(res);
        Assert.StartsWith("qbXML failed XSD validation", body.GetProperty("error").GetString());
        var err = Assert.Single(body.GetProperty("validationErrors").EnumerateArray());
        Assert.Equal(1, err.GetProperty("line").GetInt32());
        Assert.Contains("Bogus", err.GetProperty("message").GetString());
        Assert.Empty(_qb.Received);
        Assert.Equal(1, stats.SchemaRejected);
    }

    [Fact]
    public async Task Log_mode_forwards_invalid_qbxml_but_counts_it()
    {
        var (url, stats) = Start(SchemaValidationMode.Log);
        var res = await Post(url, InvalidXml);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Single(_qb.Received);
        Assert.Equal(1, stats.SchemaInvalid);
        Assert.Equal(0, stats.SchemaRejected);
    }

    [Fact]
    public async Task Off_mode_does_not_validate()
    {
        var (url, stats) = Start(SchemaValidationMode.Off);
        Assert.Equal(HttpStatusCode.OK, (await Post(url, InvalidXml)).StatusCode);
        Assert.Equal(0, stats.SchemaInvalid);
    }

    [Fact]
    public async Task Enforce_without_a_schema_fails_closed()
    {
        var missing = Path.Combine(Path.GetTempPath(), "qbv-missing-" + Guid.NewGuid().ToString("N"));
        var (url, _) = Start(SchemaValidationMode.Enforce, schemaDir: missing, schemaFile: RelayOptions.DefaultSchemaFile);
        var res = await Post(url, ValidXml);
        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        Assert.Contains("not loaded", (await Json(res)).GetProperty("error").GetString());
        Assert.Empty(_qb.Received);
    }

    [Fact]
    public async Task Wrong_or_missing_api_key_is_401()
    {
        var (url, stats) = Start();
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(url, ValidXml, key: "nope")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(url, ValidXml, key: null)).StatusCode);
        var health = await _http.GetAsync(url + "/qb/health");
        Assert.Equal(HttpStatusCode.Unauthorized, health.StatusCode);
        Assert.Equal("Invalid API key", (await Json(health)).GetProperty("error").GetString());
        Assert.Empty(_qb.Received);
        Assert.Equal(3, stats.Unauthorized);
    }

    [Fact]
    public async Task Empty_configured_key_allows_requests_without_a_key()
    {
        var (url, _) = Start(apiKey: "");
        Assert.Equal(HttpStatusCode.OK, (await Post(url, ValidXml, key: null)).StatusCode);
    }

    [Fact]
    public async Task Loopback_is_always_allowed_by_the_ip_allowlist()
    {
        var (url, _) = Start(allowed: new[] { "10.9.9.9" });
        Assert.Equal(HttpStatusCode.OK, (await Post(url, ValidXml)).StatusCode);
    }

    [Fact]
    public async Task Oversized_body_is_413_and_not_forwarded()
    {
        var (url, stats) = Start(maxBody: 2048);
        var big = ValidXml.Replace("<MaxReturned>5</MaxReturned>", "<MaxReturned>5</MaxReturned>" + new string(' ', 4096));
        var res = await Post(url, big);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
        Assert.Contains("MaxRequestBodyBytes", (await Json(res)).GetProperty("error").GetString());
        Assert.Empty(_qb.Received);
        Assert.Equal(1, stats.TooLarge);
    }

    [Fact]
    public async Task Missing_qbxml_and_invalid_json_are_400()
    {
        var (url, _) = Start();
        var empty = new HttpRequestMessage(HttpMethod.Post, url + "/qb/request") { Content = JsonContent.Create(new { other = 1 }) };
        empty.Headers.Add("X-Api-Key", Key);
        var res = await _http.SendAsync(empty);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("Missing 'qbxml' field in request body", (await Json(res)).GetProperty("error").GetString());

        var junk = new HttpRequestMessage(HttpMethod.Post, url + "/qb/request") { Content = new StringContent("{not json", Encoding.UTF8, "application/json") };
        junk.Headers.Add("X-Api-Key", Key);
        Assert.Equal(HttpStatusCode.BadRequest, (await _http.SendAsync(junk)).StatusCode);
        Assert.Empty(_qb.Received);
    }

    [Fact]
    public async Task Processor_failure_is_502()
    {
        _qb.Handler = _ => Task.FromException<string>(new InvalidOperationException("QB said no"));
        var (url, stats) = Start();
        var res = await Post(url, ValidXml);
        Assert.Equal(HttpStatusCode.BadGateway, res.StatusCode);
        Assert.Equal("QB said no", (await Json(res)).GetProperty("error").GetString());
        Assert.Equal(1, stats.Failed);
    }

    [Fact]
    public async Task Hung_request_times_out_with_504_and_restarts_the_worker()
    {
        _qb.Handler = _ => new TaskCompletionSource<string>().Task;
        var (url, stats) = Start(timeoutSeconds: 1);
        var res = await Post(url, ValidXml);
        Assert.Equal(HttpStatusCode.GatewayTimeout, res.StatusCode);
        Assert.Contains("timed out", (await Json(res)).GetProperty("error").GetString());
        Assert.Equal(1, _qb.RestartCount);
        Assert.Equal(1, stats.TimedOut);
    }

    [Fact]
    public async Task Dead_worker_is_503_immediately_and_restart_is_rate_limited()
    {
        _qb.IsRunning = false;
        _qb.LastError = "QBXMLRP2.RequestProcessor COM object not found.";
        var (url, _) = Start();
        var res = await Post(url, ValidXml);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
        Assert.Contains("COM object not found", (await Json(res)).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Post(url, ValidXml)).StatusCode);
        Assert.Equal(1, _qb.RestartCount);
        Assert.Empty(_qb.Received);
    }

    [Fact]
    public async Task Health_keeps_the_original_fields_and_adds_detail()
    {
        _qb.HostInfo = new QbHostInfo
        {
            ProductName = "QuickBooks Enterprise",
            SupportedQbxmlVersions = new[] { "13.0", "16.0" },
            QbFileMode = "MultiUser",
            FetchedAt = DateTime.UtcNow,
        };
        _qb.QueueDepth = 3;
        _qb.IsBusy = true;
        var (url, _) = Start(SchemaValidationMode.Log);
        await Post(url, InvalidXml, requestId: "req-9");
        _qb.Handler = _ => Task.FromException<string>(new InvalidOperationException("boom"));
        await Post(url, ValidXml, requestId: "req-10");

        var req = new HttpRequestMessage(HttpMethod.Get, url + "/qb/health");
        req.Headers.Add("X-Api-Key", Key);
        var res = await _http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var h = await Json(res);
        Assert.True(h.GetProperty("connected").GetBoolean());
        Assert.Equal(JsonValueKind.Null, h.GetProperty("lastError").ValueKind);
        Assert.Equal(JsonValueKind.Null, h.GetProperty("lastRequestTime").ValueKind);
        Assert.True(h.GetProperty("uptime").GetDouble() >= 0);
        Assert.Equal("9.9.9-test", h.GetProperty("version").GetString());
        Assert.Equal("16.0", h.GetProperty("qbxmlVersion").GetString());
        Assert.Equal("MultiUser", h.GetProperty("qb").GetProperty("qbFileMode").GetString());
        Assert.Equal(3, h.GetProperty("queueDepth").GetInt32());
        Assert.True(h.GetProperty("busy").GetBoolean());
        Assert.True(h.GetProperty("workerRunning").GetBoolean());
        Assert.Equal("log", h.GetProperty("validation").GetProperty("mode").GetString());
        Assert.True(h.GetProperty("validation").GetProperty("schemaLoaded").GetBoolean());
        Assert.Equal(TestSchemas.MiniEntry, h.GetProperty("validation").GetProperty("schemaFile").GetString());
        var counts = h.GetProperty("requests");
        Assert.Equal(2, counts.GetProperty("total").GetInt64());
        Assert.Equal(1, counts.GetProperty("succeeded").GetInt64());
        Assert.Equal(1, counts.GetProperty("failed").GetInt64());
        Assert.Equal(1, counts.GetProperty("schemaInvalid").GetInt64());
        var last = h.GetProperty("lastFailure");
        Assert.Equal(502, last.GetProperty("status").GetInt32());
        Assert.Equal("req-10", last.GetProperty("requestId").GetString());
        Assert.Equal("boom", last.GetProperty("message").GetString());
        Assert.Equal(RelayOptions.DefaultMaxRequestBodyBytes, h.GetProperty("limits").GetProperty("maxRequestBodyBytes").GetInt64());
    }

    [Fact]
    public async Task Restart_errors_and_unknown_routes()
    {
        var (url, _) = Start();
        var restart = new HttpRequestMessage(HttpMethod.Post, url + "/qb/restart");
        restart.Headers.Add("X-Api-Key", Key);
        var r1 = await _http.SendAsync(restart);
        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.True((await Json(r1)).GetProperty("restarted").GetBoolean());
        Assert.Equal(1, _qb.RestartCount);

        var errors = new HttpRequestMessage(HttpMethod.Get, url + "/qb/errors");
        errors.Headers.Add("X-Api-Key", Key);
        var r2 = await _http.SendAsync(errors);
        Assert.Equal(HttpStatusCode.OK, r2.StatusCode);
        Assert.StartsWith("text/plain", r2.Content.Headers.ContentType!.ToString());
        Assert.Contains("[FATAL]", await r2.Content.ReadAsStringAsync());

        var nf = new HttpRequestMessage(HttpMethod.Get, url + "/nope");
        nf.Headers.Add("X-Api-Key", Key);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.SendAsync(nf)).StatusCode);
    }

    [Fact]
    public async Task Generates_a_request_id_when_none_is_sent()
    {
        var (url, _) = Start();
        var res = await Post(url, ValidXml);
        Assert.Matches("^[0-9a-f]{32}$", res.Headers.GetValues("X-Request-Id").Single());
        Assert.Equal(res.Headers.GetValues("X-Request-Id").Single(), _qb.Received.Single().RequestId);
    }

    [SkippableFact]
    public async Task Real_schema_end_to_end_valid_and_invalid()
    {
        Skip.If(TestSchemas.RealDir == null, TestSchemas.SkipReason);
        var (url, _) = Start(SchemaValidationMode.Enforce, schemaDir: TestSchemas.RealDir, schemaFile: RelayOptions.DefaultSchemaFile);
        Assert.Equal(HttpStatusCode.OK, (await Post(url, ValidXml)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Post(url, HostQuery.BuildRequest())).StatusCode);
        var bad = await Post(url, InvalidXml);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(2, _qb.Received.Count);
    }
}
