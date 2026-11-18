using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Xml;

namespace QuickBooksVueRelay;

/// <summary>
/// Manages a dedicated STA thread for the QBSDK COM object.
/// All QB requests are serialized through this single thread.
/// On hung requests or fatal errors, the worker can be restarted to recover.
/// </summary>
public class QbWorker : IDisposable
{
    private readonly ILogger<QbWorker> _logger;
    private readonly IConfiguration _config;
    private BlockingCollection<QbJob> _queue = new();
    private Thread? _staThread;
    private volatile bool _connected;
    private volatile string? _lastError;
    private DateTime _lastRequestTime = DateTime.MinValue;
    private readonly object _restartLock = new();
    private readonly string _errorLogPath;

    public bool IsConnected => _connected;
    public string? LastError => _lastError;
    public DateTime LastRequestTime => _lastRequestTime;

    public QbWorker(ILogger<QbWorker> logger, IConfiguration config)
    {
        _logger = logger;
        _config = config;
        _errorLogPath = Path.Combine(AppContext.BaseDirectory, "qb-errors.log");
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

    /// <summary>
    /// Forcibly restart the worker thread. Used to recover from hung COM calls
    /// (e.g., when QB displays a modal error dialog and ProcessRequest never returns).
    /// </summary>
    public void Restart()
    {
        lock (_restartLock)
        {
            _logger.LogWarning("Restarting QB worker thread...");
            LogError("MANUAL_RESTART", "Worker restart requested");

            try
            {
                _queue.CompleteAdding();
                // Don't wait — the old thread may be hung. Let it die naturally.
                _staThread = null;
            }
            catch { }

            _queue = new BlockingCollection<QbJob>();
            _connected = false;
            _lastError = "Restarting...";
            Start();
        }
    }

    private void ProcessLoop()
    {
        var relayConfig = _config.GetSection("Relay");
        var qbFilePath = relayConfig["QbFilePath"] ?? "";
        var appName = relayConfig["AppName"] ?? "QuickBooks Vue Relay";
        var appId = relayConfig["AppID"] ?? "QuickBooksVue";

        // Multi-user coexistence: when QuickBooks already has the company file
        // open (e.g. a human in Multi-User Mode), the relay must ATTACH to that
        // open file by passing an EMPTY path. Passing an explicit QbFilePath
        // makes QB try to open THAT file in its own default (single-user) mode,
        // which either single-locks the file (if QB was closed) or collides
        // with the already-open multi-user file ("opened in a mode other than
        // the one specified"). Empty path = use whatever file QB has open, in
        // its current mode. Set AttachToOpenFile=false only for unattended runs
        // where the relay should auto-open a closed file (always single-user).
        // Default true; only an explicit "false" opts into auto-opening a
        // closed file. Plain indexer avoids the Configuration.Binder extension.
        var attachToOpenFile = (relayConfig["AttachToOpenFile"] ?? "true").Trim().ToLowerInvariant() != "false";
        var sessionPath = attachToOpenFile ? "" : qbFilePath;

        // BeginSession open mode: 0=DoNotCare, 1=SingleUser, 2=MultiUser.
        // DoNotCare normally attaches to the open file in its current mode, but
        // some QB builds resolve it to single-user and reject a multi-user
        // file. If running alongside multi-user QuickBooks fails with a mode
        // mismatch, set OpenMode=2 to explicitly join the multi-user session.
        var openMode = int.TryParse(relayConfig["OpenMode"], out var m) ? m : 0;

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
                LogError("STARTUP", _lastError);
                FailAllPending(_lastError);
                return;
            }

            rp = Activator.CreateInstance(rpType);
            if (rp == null)
            {
                _lastError = "Failed to create QBXMLRP2.RequestProcessor instance.";
                _logger.LogError(_lastError);
                LogError("STARTUP", _lastError);
                FailAllPending(_lastError);
                return;
            }

            // Open connection
            rp.OpenConnection2(appId, appName, 1 /* localQBD */);
            _logger.LogInformation("QB connection opened: {AppName}", appName);

            // qbFileOpenDoNotCare (0) + empty sessionPath: attach to the file
            // QuickBooks already has open, in its current mode (see above).
            ticket = rp.BeginSession(sessionPath, openMode);
            _connected = true;
            _lastError = null;
            _logger.LogInformation("QB session started (attachToOpenFile={Attach}, openMode={Mode})", attachToOpenFile, openMode);

            // Process jobs from the queue
            foreach (var job in _queue.GetConsumingEnumerable())
            {
                try
                {
                    // Validate XML well-formedness BEFORE sending to QB
                    // This catches the most common cause of QB crashes (malformed XML)
                    if (!IsWellFormedXml(job.QbXml, out var xmlError))
                    {
                        var msg = $"Malformed XML rejected before sending to QB: {xmlError}";
                        _logger.LogWarning(msg);
                        LogError("XML_VALIDATION", msg, job.QbXml);
                        job.Tcs.SetException(new InvalidOperationException(msg));
                        continue;
                    }

                    _lastRequestTime = DateTime.UtcNow;
                    string response = rp.ProcessRequest(ticket, job.QbXml);
                    job.Tcs.SetResult(response);
                    // Successful request means the session is healthy
                    _connected = true;
                    _lastError = null;
                }
                catch (COMException comEx)
                {
                    // Request-level errors (QB rejected THIS request's qbXML —
                    // spec violations, unknown elements, version mismatches) do
                    // NOT poison the session. Tearing the connection down and
                    // re-running BeginSession took ~30s per malformed request
                    // and stalled every queued job behind it. Only genuine
                    // connection/session faults trigger a reconnect.
                    if (IsRequestLevelError(comEx))
                    {
                        _logger.LogWarning("QB rejected request (session kept): {Message}", comEx.Message);
                        LogError("QB_PARSE_REJECT", $"HRESULT 0x{comEx.HResult:X8}: {comEx.Message}", job.QbXml);
                        job.Tcs.SetException(comEx);
                        // Session is healthy — the next queued job proceeds immediately.
                        _connected = true;
                        _lastError = null;
                        continue;
                    }

                    _logger.LogError(comEx, "QB COM exception (HRESULT: 0x{HResult:X8})", comEx.HResult);
                    LogError("COM_EXCEPTION", $"HRESULT 0x{comEx.HResult:X8}: {comEx.Message}", job.QbXml);
                    _connected = false;
                    _lastError = comEx.Message;
                    job.Tcs.SetException(comEx);
                    TryReconnect(ref rp, ref ticket, sessionPath, openMode, appId, appName);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "QB ProcessRequest failed");
                    LogError("REQUEST_FAILED", ex.Message, job.QbXml);
                    job.Tcs.SetException(ex);
                }
            }
        }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            _logger.LogError(ex, "QB worker thread fatal error");
            LogError("FATAL", ex.ToString());
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

    private void TryReconnect(ref dynamic? rp, ref string? ticket, string sessionPath, int openMode, string appId, string appName)
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
            ticket = rp.BeginSession(sessionPath, openMode);
            _connected = true;
            _lastError = null;
            _logger.LogInformation("QB reconnected successfully");
        }
        catch (Exception ex)
        {
            _lastError = $"Reconnect failed: {ex.Message}";
            _logger.LogError(ex, "QB reconnect failed");
            LogError("RECONNECT_FAILED", ex.Message);
            _connected = false;
        }
    }

    /// <summary>
    /// QBXMLRP2 raises COMExceptions both for request-level problems (the qbXML
    /// itself is unparseable / uses an element QB doesn't know) and for genuine
    /// session faults (ticket invalid, connection dropped). Request-level ones
    /// are deterministic client bugs — the session stays valid and must be kept.
    /// 0x80040400 is QB_E_QBXML (the "error when parsing the provided XML text
    /// stream" class); message needles cover localized/variant phrasings.
    /// </summary>
    private static bool IsRequestLevelError(COMException ex)
    {
        if ((uint)ex.HResult == 0x80040400) return true;

        var m = (ex.Message ?? "").ToLowerInvariant();
        return m.Contains("parsing the provided xml")
            || m.Contains("not well-formed")
            || m.Contains("could not be parsed")
            || m.Contains("xml text stream")
            || m.Contains("unsupported version");
    }

    private static bool IsWellFormedXml(string xml, out string error)
    {
        error = "";
        try
        {
            var doc = new XmlDocument();
            doc.LoadXml(xml);
            return true;
        }
        catch (XmlException ex)
        {
            error = $"Line {ex.LineNumber}, Position {ex.LinePosition}: {ex.Message}";
            return false;
        }
    }

    private void LogError(string category, string message, string? requestXml = null)
    {
        try
        {
            var entry = $"[{DateTime.UtcNow:o}] [{category}] {message}\n";
            if (!string.IsNullOrEmpty(requestXml))
            {
                var preview = requestXml.Length > 500 ? requestXml.Substring(0, 500) + "..." : requestXml;
                entry += $"  Request: {preview}\n";
            }
            entry += "\n";
            File.AppendAllText(_errorLogPath, entry);
        }
        catch { /* logging must never throw */ }
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

    /// <summary>
    /// Read the most recent error log entries (for the /qb/errors endpoint).
    /// </summary>
    public string GetRecentErrors(int maxBytes = 20000)
    {
        try
        {
            if (!File.Exists(_errorLogPath)) return "";
            var fileInfo = new FileInfo(_errorLogPath);
            if (fileInfo.Length <= maxBytes)
            {
                return File.ReadAllText(_errorLogPath);
            }
            using var fs = File.OpenRead(_errorLogPath);
            fs.Seek(-maxBytes, SeekOrigin.End);
            using var reader = new StreamReader(fs);
            return "...(truncated)...\n" + reader.ReadToEnd();
        }
        catch (Exception ex)
        {
            return $"Error reading log: {ex.Message}";
        }
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
