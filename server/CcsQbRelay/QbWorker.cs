using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace CcsQbRelay;

/// <summary>
/// Manages a dedicated STA thread for the QBSDK COM object.
/// All QB requests are serialized through this single thread.
/// </summary>
public class QbWorker : IDisposable
{
    private readonly ILogger<QbWorker> _logger;
    private readonly IConfiguration _config;
    private readonly BlockingCollection<QbJob> _queue = new();
    private Thread? _staThread;
    private volatile bool _connected;
    private volatile string? _lastError;
    private DateTime _lastRequestTime = DateTime.MinValue;

    public bool IsConnected => _connected;
    public string? LastError => _lastError;
    public DateTime LastRequestTime => _lastRequestTime;

    public QbWorker(ILogger<QbWorker> logger, IConfiguration config)
    {
        _logger = logger;
        _config = config;
    }

    public void Start()
    {
        _staThread = new Thread(ProcessLoop)
        {
            IsBackground = true,
            Name = "QB-STA-Worker"
        };
        _staThread.SetApartmentState(ApartmentState.STA);
        _staThread.Start();
    }

    private void ProcessLoop()
    {
        var relayConfig = _config.GetSection("Relay");
        var qbFilePath = relayConfig["QbFilePath"] ?? "";
        var appName = relayConfig["AppName"] ?? "CCS ERP Relay";
        var appId = relayConfig["AppID"] ?? "CCSRelay";

        dynamic? rp = null;
        string? ticket = null;

        try
        {
            // Create the COM object on this STA thread
            var rpType = Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor");
            if (rpType == null)
            {
                _lastError = "QBXMLRP2.RequestProcessor COM object not found. Is the QuickBooks SDK installed?";
                _logger.LogError(_lastError);
                FailAllPending(_lastError);
                return;
            }

            rp = Activator.CreateInstance(rpType);
            if (rp == null)
            {
                _lastError = "Failed to create QBXMLRP2.RequestProcessor instance.";
                _logger.LogError(_lastError);
                FailAllPending(_lastError);
                return;
            }

            // Open connection
            rp.OpenConnection2(appId, appName, 1 /* localQBD */);
            _logger.LogInformation("QB connection opened: {AppName}", appName);

            // Begin session (multi-user mode = 2)
            ticket = rp.BeginSession(qbFilePath, 2 /* qbFileOpenMultiUser */);
            _connected = true;
            _lastError = null;
            _logger.LogInformation("QB session started: {FilePath}", qbFilePath);

            // Process jobs from the queue
            foreach (var job in _queue.GetConsumingEnumerable())
            {
                try
                {
                    _lastRequestTime = DateTime.UtcNow;
                    string response = rp.ProcessRequest(ticket, job.QbXml);
                    job.Tcs.SetResult(response);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "QB ProcessRequest failed");
                    job.Tcs.SetException(ex);

                    // If COM faulted, try to reconnect
                    if (ex is COMException)
                    {
                        _connected = false;
                        _lastError = ex.Message;
                        TryReconnect(ref rp, ref ticket, qbFilePath, appId, appName);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            _logger.LogError(ex, "QB worker thread fatal error");
            _connected = false;
            FailAllPending(ex.Message);
        }
        finally
        {
            // Cleanup
            if (ticket != null && rp != null)
            {
                try { rp.EndSession(ticket); } catch { }
            }
            if (rp != null)
            {
                try { rp.CloseConnection(); } catch { }
                try { Marshal.ReleaseComObject(rp); } catch { }
            }
            _connected = false;
        }
    }

    private void TryReconnect(ref dynamic? rp, ref string? ticket, string qbFilePath, string appId, string appName)
    {
        _logger.LogWarning("Attempting QB reconnect...");

        // Cleanup old connection
        if (ticket != null && rp != null)
        {
            try { rp.EndSession(ticket); } catch { }
        }
        if (rp != null)
        {
            try { rp.CloseConnection(); } catch { }
            try { Marshal.ReleaseComObject(rp); } catch { }
        }

        Thread.Sleep(2000); // Brief pause before reconnecting

        try
        {
            var rpType = Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor");
            rp = Activator.CreateInstance(rpType!);
            rp!.OpenConnection2(appId, appName, 1);
            ticket = rp.BeginSession(qbFilePath, 2);
            _connected = true;
            _lastError = null;
            _logger.LogInformation("QB reconnected successfully");
        }
        catch (Exception ex)
        {
            _lastError = $"Reconnect failed: {ex.Message}";
            _logger.LogError(ex, "QB reconnect failed");
            _connected = false;
        }
    }

    private void FailAllPending(string error)
    {
        while (_queue.TryTake(out var job))
        {
            job.Tcs.SetException(new Exception(error));
        }
    }

    /// <summary>
    /// Enqueue a qbXML request from any thread. Returns the response asynchronously.
    /// </summary>
    public Task<string> ProcessRequestAsync(string qbXml)
    {
        var job = new QbJob { QbXml = qbXml, Tcs = new TaskCompletionSource<string>() };
        _queue.Add(job);
        return job.Tcs.Task;
    }

    public void Dispose()
    {
        _queue.CompleteAdding();
        _staThread?.Join(TimeSpan.FromSeconds(5));
        _queue.Dispose();
    }
}

internal record QbJob
{
    public required string QbXml { get; init; }
    public required TaskCompletionSource<string> Tcs { get; init; }
}
