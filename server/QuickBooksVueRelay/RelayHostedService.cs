using System.Net;
using System.Reflection;

namespace QuickBooksVueRelay;

/// <summary>
/// Hosted service that starts the QuickBooks worker thread and the HTTP listener.
/// Routing and request handling live in <see cref="RelayHttpServer"/>.
/// </summary>
public class RelayHostedService : BackgroundService
{
    private readonly ILogger<RelayHostedService> _logger;
    private readonly RelayOptions _options;
    private readonly QbWorker _qbWorker;
    private readonly SchemaValidationService _validation;
    private readonly RelayStats _stats;

    public RelayHostedService(ILogger<RelayHostedService> logger, RelayOptions options, QbWorker qbWorker,
        SchemaValidationService validation, RelayStats stats)
    {
        _logger = logger;
        _options = options;
        _qbWorker = qbWorker;
        _validation = validation;
        _stats = stats;
    }

    public static string Version =>
        typeof(RelayHostedService).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(RelayHostedService).Assembly.GetName().Version?.ToString()
        ?? "unknown";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var warning in _options.Warnings)
        {
            _logger.LogWarning("{Warning}", warning);
        }

        // Start the QB worker thread
        _qbWorker.Start();
        _logger.LogInformation("QB worker started (relay {Version})", Version);

        var server = new RelayHttpServer(_options, _qbWorker, _validation, _stats, _logger, Version);
        if (!server.Auth.IsRequired)
        {
            _logger.LogWarning("Relay:ApiKey is empty: every allowlisted caller is accepted without a key. Set a strong ApiKey.");
        }
        else if (server.Auth.IsPlaceholder)
        {
            _logger.LogWarning("Relay:ApiKey is still the placeholder from appsettings.json. Set a strong ApiKey.");
        }
        foreach (var bad in server.AllowList.InvalidEntries)
        {
            _logger.LogWarning("Relay:AllowedIPs entry '{Entry}' is not an IP address or CIDR range; it is compared as plain text", bad);
        }

        try
        {
            server.Start();
            _logger.LogInformation("HTTP listener started on port {Port}", _options.Port);
        }
        catch (HttpListenerException ex)
        {
            _logger.LogError(ex, "Failed to start HTTP listener on port {Port}. Run as admin or use: netsh http add urlacl url=http://+:{UrlPort}/ user=Everyone", _options.Port, _options.Port);
            return;
        }

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        finally
        {
            await server.DisposeAsync();
            _qbWorker.Dispose();
        }
    }
}
