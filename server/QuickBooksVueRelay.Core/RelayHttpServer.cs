using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace QuickBooksVueRelay;

/// <summary>
/// The relay's HTTP surface on HttpListener:
///   GET  /qb/health   status and counters
///   POST /qb/request  {qbxml} -> {response, error}
///   POST /qb/restart  restart the QuickBooks worker thread
///   GET  /qb/errors   tail of the error log
/// Every route requires the allowlisted address and X-Api-Key (when configured).
/// </summary>
public sealed class RelayHttpServer : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOut = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly JsonSerializerOptions JsonIn = new() { PropertyNameCaseInsensitive = true };
    private static readonly TimeSpan MinAutoRestartInterval = TimeSpan.FromSeconds(15);

    private readonly RelayOptions _options;
    private readonly IQbProcessor _qb;
    private readonly SchemaValidationService _validation;
    private readonly RelayStats _stats;
    private readonly ILogger _logger;
    private readonly ApiKeyAuth _auth;
    private readonly IpAllowList _allowList;
    private readonly string _version;
    private readonly DateTime _processStart;
    private readonly object _restartLock = new();
    private DateTime _lastAutoRestart = DateTime.MinValue;
    private HttpListener? _listener;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    public RelayHttpServer(RelayOptions options, IQbProcessor qb, SchemaValidationService validation, RelayStats stats, ILogger logger, string version)
    {
        _options = options;
        _qb = qb;
        _validation = validation;
        _stats = stats;
        _logger = logger;
        _version = version;
        _auth = new ApiKeyAuth(options.ApiKey);
        _allowList = new IpAllowList(options.AllowedIPs);
        try
        {
            _processStart = Process.GetCurrentProcess().StartTime.ToUniversalTime();
        }
        catch (Exception)
        {
            _processStart = stats.StartedAt;
        }
    }

    public ApiKeyAuth Auth => _auth;
    public IpAllowList AllowList => _allowList;

    /// <summary>Start listening (production prefix: http://+:{Port}/). Throws HttpListenerException on bind failure.</summary>
    public void Start(string? prefix = null)
    {
        _listener = new HttpListener();
        _listener.Prefixes.Add(prefix ?? $"http://+:{_options.Port}/");
        _listener.Start();
        _cts = new CancellationTokenSource();
        _loop = AcceptLoopAsync(_listener, _cts.Token);
    }

    /// <summary>Completes when the accept loop ends (after StopAsync or a listener failure).</summary>
    public Task Completion => _loop ?? Task.CompletedTask;

    public async Task StopAsync()
    {
        _cts?.Cancel();
        try
        {
            _listener?.Stop();
        }
        catch (ObjectDisposedException)
        {
        }
        if (_loop != null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
        _listener?.Close();
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _cts?.Dispose();
    }

    private async Task AcceptLoopAsync(HttpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().WaitAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
                if (ct.IsCancellationRequested || !listener.IsListening) break;
                _logger.LogError(ex, "Error accepting HTTP request");
                continue;
            }
            _ = HandleAsync(context);
        }
    }

    /// <summary>Handle one HTTP exchange. Never throws.</summary>
    public async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        var requestId = RequestIds.Resolve(request.Headers[RequestIds.HeaderName]);
        var path = request.Url?.AbsolutePath ?? "";
        var sw = Stopwatch.StartNew();
        var status = 500;

        try
        {
            response.AddHeader(RequestIds.HeaderName, requestId);
            status = await RouteAsync(request, response, path, requestId).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[{RequestId}] Unhandled error in request handler", requestId);
            status = 500;
            await TryWriteJson(response, 500, new { error = "Internal server error" }).ConfigureAwait(false);
        }
        finally
        {
            var level = path == "/qb/health" ? LogLevel.Debug : status >= 500 ? LogLevel.Warning : LogLevel.Information;
            _logger.Log(level, "[{RequestId}] {Method} {Path} from {Remote} -> {Status} in {Ms} ms",
                requestId, request.HttpMethod, path, request.RemoteEndPoint?.Address, status, sw.ElapsedMilliseconds);
        }
    }

    private async Task<int> RouteAsync(HttpListenerRequest request, HttpListenerResponse response, string path, string requestId)
    {
        if (!_allowList.IsAllowed(request.RemoteEndPoint?.Address))
        {
            return await WriteJson(response, 403, new { error = "IP not allowed" }).ConfigureAwait(false);
        }

        if (!_auth.IsAuthorized(request.Headers["X-Api-Key"]))
        {
            _stats.UnauthorizedSeen();
            return await WriteJson(response, 401, new { error = "Invalid API key" }).ConfigureAwait(false);
        }

        var method = request.HttpMethod;
        if (method == "GET" && path == "/qb/health")
        {
            return await WriteJson(response, 200, BuildHealth()).ConfigureAwait(false);
        }
        if (method == "POST" && path == "/qb/request")
        {
            return await HandleQbRequestAsync(request, response, requestId).ConfigureAwait(false);
        }
        if (method == "POST" && path == "/qb/restart")
        {
            _logger.LogWarning("[{RequestId}] Worker restart requested over HTTP", requestId);
            _qb.Restart();
            return await WriteJson(response, 200, new { restarted = true }).ConfigureAwait(false);
        }
        if (method == "GET" && path == "/qb/errors")
        {
            var buffer = Encoding.UTF8.GetBytes(_qb.GetRecentErrors());
            response.StatusCode = 200;
            response.ContentType = "text/plain; charset=utf-8";
            response.ContentLength64 = buffer.Length;
            await response.OutputStream.WriteAsync(buffer).ConfigureAwait(false);
            response.Close();
            return 200;
        }

        return await WriteJson(response, 404, new { error = "Not found. Routes: GET /qb/health, POST /qb/request, POST /qb/restart, GET /qb/errors" }).ConfigureAwait(false);
    }

    private async Task<int> HandleQbRequestAsync(HttpListenerRequest request, HttpListenerResponse response, string requestId)
    {
        _stats.Request();

        string body;
        try
        {
            body = await BoundedBody.ReadAsStringAsync(request.InputStream, request.ContentLength64, _options.MaxRequestBodyBytes, request.ContentEncoding).ConfigureAwait(false);
        }
        catch (PayloadTooLargeException ex)
        {
            _stats.Failure(413, requestId, ex.Message, FailureKind.TooLarge);
            _logger.LogWarning("[{RequestId}] {Error}", requestId, ex.Message);
            // The rest of the body is not read, so the connection cannot be reused.
            response.KeepAlive = false;
            return await WriteJson(response, 413, new { response = (string?)null, error = ex.Message }).ConfigureAwait(false);
        }

        QbRequestPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<QbRequestPayload>(body, JsonIn);
        }
        catch (JsonException ex)
        {
            _stats.Failure(400, requestId, "Invalid JSON body");
            return await WriteJson(response, 400, new { response = (string?)null, error = $"Request body is not valid JSON: {ex.Message}" }).ConfigureAwait(false);
        }

        if (string.IsNullOrWhiteSpace(payload?.Qbxml))
        {
            _stats.Failure(400, requestId, "Missing 'qbxml' field in request body");
            return await WriteJson(response, 400, new { error = "Missing 'qbxml' field in request body" }).ConfigureAwait(false);
        }
        var qbxml = payload.Qbxml;

        var outcome = _validation.Check(qbxml);
        if (outcome.Result is { Valid: false } invalid)
        {
            _stats.SchemaInvalidSeen();
            _logger.LogWarning("[{RequestId}] qbXML failed XSD validation ({Mode}): {Errors}", requestId, _validation.Mode, invalid.Summary());
        }
        switch (outcome.Action)
        {
            case ValidationAction.Reject:
            {
                var result = outcome.Result!;
                var message = $"qbXML failed XSD validation: {result.Summary()}";
                _stats.Failure(400, requestId, message, FailureKind.SchemaRejected);
                return await WriteJson(response, 400, new
                {
                    response = (string?)null,
                    error = message,
                    validationErrors = result.Errors.Select(e => new { line = e.Line, column = e.Column, message = e.Message }),
                }).ConfigureAwait(false);
            }
            case ValidationAction.SchemaUnavailable:
            {
                var message = $"Relay:ValidateSchema is 'enforce' but the qbXML schema is not loaded: {_validation.LoadError}";
                _stats.Failure(500, requestId, message);
                return await WriteJson(response, 500, new { response = (string?)null, error = message }).ConfigureAwait(false);
            }
        }

        if (!_qb.IsRunning)
        {
            // The worker thread exited (e.g. the SDK COM object could not be created).
            // Queuing would only wait for the timeout, so answer now and try a restart.
            var message = $"QuickBooks worker is not running: {_qb.LastError ?? "unknown error"}";
            _stats.Failure(503, requestId, message);
            MaybeAutoRestart(requestId);
            return await WriteJson(response, 503, new { response = (string?)null, error = message }).ConfigureAwait(false);
        }

        var timeout = TimeSpan.FromSeconds(_options.RequestTimeoutSeconds);
        _logger.LogDebug("[{RequestId}] Forwarding qbXML ({Length} chars, queue depth {Depth}, timeout {Timeout}s)",
            requestId, qbxml.Length, _qb.QueueDepth, _options.RequestTimeoutSeconds);

        try
        {
            var qbResponse = await _qb.ProcessRequestAsync(qbxml, requestId).WaitAsync(timeout).ConfigureAwait(false);
            _stats.Success();
            return await WriteJson(response, 200, new { response = qbResponse, error = (string?)null }).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // A hung COM call (typically QuickBooks showing a modal dialog) blocks the
            // STA thread; restart it or every later request queues behind the hang.
            var message = $"QB request timed out ({_options.RequestTimeoutSeconds}s) — worker restarted";
            _logger.LogWarning("[{RequestId}] QB request timed out after {Timeout}s — restarting worker", requestId, _options.RequestTimeoutSeconds);
            _stats.Failure(504, requestId, message, FailureKind.TimedOut);
            _qb.Restart();
            return await WriteJson(response, 504, new { error = message }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[{RequestId}] QB request failed", requestId);
            _stats.Failure(502, requestId, ex.Message);
            return await WriteJson(response, 502, new { error = ex.Message }).ConfigureAwait(false);
        }
    }

    private void MaybeAutoRestart(string requestId)
    {
        lock (_restartLock)
        {
            if (DateTime.UtcNow - _lastAutoRestart < MinAutoRestartInterval) return;
            _lastAutoRestart = DateTime.UtcNow;
        }
        _logger.LogWarning("[{RequestId}] QuickBooks worker is not running; restarting it", requestId);
        _qb.Restart();
    }

    /// <summary>The /qb/health document. The first four fields are the original contract.</summary>
    public object BuildHealth()
    {
        var host = _qb.HostInfo;
        var failure = _stats.LastFailure;
        return new
        {
            connected = _qb.IsConnected,
            lastError = _qb.LastError,
            lastRequestTime = _qb.LastRequestTime == DateTime.MinValue ? null : _qb.LastRequestTime.ToString("o"),
            uptime = (DateTime.UtcNow - _processStart).TotalSeconds,
            version = _version,
            workerRunning = _qb.IsRunning,
            busy = _qb.IsBusy,
            queueDepth = _qb.QueueDepth,
            restarts = _qb.Restarts,
            lastErrorTime = _qb.LastErrorTime?.ToString("o"),
            qbxmlVersion = host?.MaxQbxmlVersion,
            qb = host == null
                ? null
                : new
                {
                    productName = host.ProductName,
                    majorVersion = host.MajorVersion,
                    minorVersion = host.MinorVersion,
                    country = host.Country,
                    supportedQbxmlVersions = host.SupportedQbxmlVersions,
                    qbFileMode = host.QbFileMode,
                    isAutomaticLogin = host.IsAutomaticLogin,
                    fetchedAt = host.FetchedAt.ToString("o"),
                },
            validation = new
            {
                mode = _validation.Mode.ToString().ToLowerInvariant(),
                schemaLoaded = _validation.SchemaLoaded,
                schemaFile = Path.GetFileName(_validation.SchemaPath),
                error = _validation.LoadError,
            },
            requests = new
            {
                total = _stats.Total,
                succeeded = _stats.Succeeded,
                failed = _stats.Failed,
                timedOut = _stats.TimedOut,
                schemaInvalid = _stats.SchemaInvalid,
                schemaRejected = _stats.SchemaRejected,
                tooLarge = _stats.TooLarge,
                unauthorized = _stats.Unauthorized,
            },
            lastFailure = failure == null
                ? null
                : new { at = failure.At.ToString("o"), status = failure.Status, requestId = failure.RequestId, message = failure.Message },
            limits = new
            {
                maxRequestBodyBytes = _options.MaxRequestBodyBytes,
                requestTimeoutSeconds = _options.RequestTimeoutSeconds,
            },
        };
    }

    private static async Task<int> WriteJson(HttpListenerResponse response, int statusCode, object data)
    {
        response.StatusCode = statusCode;
        response.ContentType = "application/json";
        var buffer = JsonSerializer.SerializeToUtf8Bytes(data, JsonOut);
        response.ContentLength64 = buffer.Length;
        await response.OutputStream.WriteAsync(buffer).ConfigureAwait(false);
        response.Close();
        return statusCode;
    }

    private static async Task TryWriteJson(HttpListenerResponse response, int statusCode, object data)
    {
        try
        {
            await WriteJson(response, statusCode, data).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The response may already be partly written or closed.
        }
    }
}

internal sealed record QbRequestPayload
{
    public string? Qbxml { get; init; }
}
