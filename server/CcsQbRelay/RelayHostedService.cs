using System.Net;
using System.Text;
using System.Text.Json;

namespace CcsQbRelay;

/// <summary>
/// Hosted service that runs the HTTP listener and dispatches requests to the QbWorker.
/// </summary>
public class RelayHostedService : BackgroundService
{
    private readonly ILogger<RelayHostedService> _logger;
    private readonly IConfiguration _config;
    private readonly QbWorker _qbWorker;
    private HttpListener? _listener;

    public RelayHostedService(ILogger<RelayHostedService> logger, IConfiguration config, QbWorker qbWorker)
    {
        _logger = logger;
        _config = config;
        _qbWorker = qbWorker;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var relayConfig = _config.GetSection("Relay");
        var port = relayConfig.GetValue<int>("Port", 9123);
        var apiKey = relayConfig["ApiKey"] ?? "";
        var allowedIPs = relayConfig.GetSection("AllowedIPs").Get<string[]>() ?? Array.Empty<string>();

        // Start the QB worker thread
        _qbWorker.Start();
        _logger.LogInformation("QB worker started");

        // Start the HTTP listener
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://+:{port}/");

        try
        {
            _listener.Start();
            _logger.LogInformation("HTTP listener started on port {Port}", port);
        }
        catch (HttpListenerException ex)
        {
            _logger.LogError(ex, "Failed to start HTTP listener on port {Port}. Run as admin or use: netsh http add urlacl url=http://+:{Port}/ user=Everyone", port);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var context = await _listener.GetContextAsync().WaitAsync(stoppingToken);
                _ = HandleRequestAsync(context, apiKey, allowedIPs);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error accepting HTTP request");
            }
        }

        _listener.Stop();
        _qbWorker.Dispose();
    }

    private async Task HandleRequestAsync(HttpListenerContext context, string apiKey, string[] allowedIPs)
    {
        var request = context.Request;
        var response = context.Response;

        try
        {
            // IP whitelist check
            if (allowedIPs.Length > 0)
            {
                var remoteIP = request.RemoteEndPoint?.Address?.ToString() ?? "";
                if (!allowedIPs.Contains(remoteIP) && remoteIP != "::1" && remoteIP != "127.0.0.1")
                {
                    await WriteJsonResponse(response, 403, new { error = "IP not allowed" });
                    return;
                }
            }

            // API key check
            var providedKey = request.Headers["X-Api-Key"] ?? "";
            if (!string.IsNullOrEmpty(apiKey) && providedKey != apiKey)
            {
                await WriteJsonResponse(response, 401, new { error = "Invalid API key" });
                return;
            }

            // Route: GET /qb/health
            if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/qb/health")
            {
                await WriteJsonResponse(response, 200, new
                {
                    connected = _qbWorker.IsConnected,
                    lastError = _qbWorker.LastError,
                    lastRequestTime = _qbWorker.LastRequestTime == DateTime.MinValue
                        ? null
                        : _qbWorker.LastRequestTime.ToString("o"),
                    uptime = (DateTime.UtcNow - System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).TotalSeconds,
                });
                return;
            }

            // Route: POST /qb/request
            if (request.HttpMethod == "POST" && request.Url?.AbsolutePath == "/qb/request")
            {
                // Don't check IsConnected here — let the worker try and report failure
                // (the connected flag may be stale; the request itself will fail cleanly if QB is down)

                // Read request body
                using var reader = new StreamReader(request.InputStream, request.ContentEncoding);
                var body = await reader.ReadToEndAsync();

                var payload = JsonSerializer.Deserialize<QbRequestPayload>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (string.IsNullOrWhiteSpace(payload?.Qbxml))
                {
                    await WriteJsonResponse(response, 400, new { error = "Missing 'qbxml' field in request body" });
                    return;
                }

                var requestTimeout = _config.GetSection("Relay").GetValue<int>("RequestTimeout", 120);
                _logger.LogDebug("Processing qbXML request ({Length} chars, timeout {Timeout}s)", payload.Qbxml.Length, requestTimeout);

                try
                {
                    var qbResponse = await _qbWorker.ProcessRequestAsync(payload.Qbxml)
                        .WaitAsync(TimeSpan.FromSeconds(requestTimeout));

                    await WriteJsonResponse(response, 200, new { response = qbResponse, error = (string?)null });
                }
                catch (TimeoutException)
                {
                    // A hung COM call (e.g., QB displaying a modal error dialog) requires
                    // restarting the worker thread to recover. Otherwise all subsequent
                    // requests will queue up behind the hung call.
                    _logger.LogWarning("QB request timed out after {Timeout}s — restarting worker", requestTimeout);
                    _qbWorker.Restart();
                    await WriteJsonResponse(response, 504, new { error = $"QB request timed out ({requestTimeout}s) — worker restarted" });
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "QB request failed");
                    await WriteJsonResponse(response, 502, new { error = ex.Message });
                }

                return;
            }

            // Route: POST /qb/restart - manually restart the worker thread
            if (request.HttpMethod == "POST" && request.Url?.AbsolutePath == "/qb/restart")
            {
                _qbWorker.Restart();
                await WriteJsonResponse(response, 200, new { restarted = true });
                return;
            }

            // Route: GET /qb/errors - read recent error log entries
            if (request.HttpMethod == "GET" && request.Url?.AbsolutePath == "/qb/errors")
            {
                var errors = _qbWorker.GetRecentErrors();
                response.StatusCode = 200;
                response.ContentType = "text/plain";
                var buffer = Encoding.UTF8.GetBytes(errors);
                response.ContentLength64 = buffer.Length;
                await response.OutputStream.WriteAsync(buffer);
                response.Close();
                return;
            }

            // 404 for anything else
            await WriteJsonResponse(response, 404, new { error = "Not found. Routes: GET /qb/health, POST /qb/request, POST /qb/restart, GET /qb/errors" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled error in request handler");
            try
            {
                await WriteJsonResponse(response, 500, new { error = "Internal server error" });
            }
            catch { }
        }
    }

    private static async Task WriteJsonResponse(HttpListenerResponse response, int statusCode, object data)
    {
        response.StatusCode = statusCode;
        response.ContentType = "application/json";
        var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        var buffer = Encoding.UTF8.GetBytes(json);
        response.ContentLength64 = buffer.Length;
        await response.OutputStream.WriteAsync(buffer);
        response.Close();
    }
}

internal record QbRequestPayload
{
    public string? Qbxml { get; init; }
}
