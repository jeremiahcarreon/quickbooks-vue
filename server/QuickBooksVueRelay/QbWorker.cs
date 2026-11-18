using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Xml;

namespace QuickBooksVueRelay;

/// <summary>
/// Manages a dedicated STA thread for the QBSDK COM object.
/// All QB requests are serialized through this single thread.
/// On hung requests or fatal errors, the worker can be restarted to recover.
/// </summary>
public class QbWorker : IQbProcessor, IDisposable
{
    private readonly ILogger<QbWorker> _logger;
    private readonly RelayOptions _options;
    private readonly SchemaValidationService _validation;
    private BlockingCollection<QbJob> _queue = new();
    private Thread? _staThread;
    // Incremented on every (re)start. A thread abandoned by Restart() keeps
    // running until its COM call returns; it must not overwrite the state of
    // the thread that replaced it, so state writes check the generation.
    private int _generation;
    private volatile bool _connected;
    private volatile bool _busy;
    private volatile string? _lastError;
    private DateTime? _lastErrorTime;
    private DateTime _lastRequestTime = DateTime.MinValue;
    private volatile QbHostInfo? _hostInfo;
    private int _restarts;
    private readonly object _restartLock = new();
    private readonly string _errorLogPath;

    public bool IsConnected => _connected;
    public bool IsRunning => _staThread?.IsAlive == true;
    public bool IsBusy => _busy;
    public string? LastError => _lastError;
    public DateTime? LastErrorTime => _lastErrorTime;
    public DateTime LastRequestTime => _lastRequestTime;
    public int QueueDepth
    {
        get
        {
            try { return _queue.Count; }
            catch (ObjectDisposedException) { return 0; }
        }
    }
    public QbHostInfo? HostInfo => _hostInfo;
    public int Restarts => Volatile.Read(ref _restarts);

    public QbWorker(ILogger<QbWorker> logger, RelayOptions options, SchemaValidationService validation)
    {
        _logger = logger;
        _options = options;
        _validation = validation;
        _errorLogPath = Path.Combine(AppContext.BaseDirectory, "qb-errors.log");
    }

    public void Start()
    {
        var generation = Interlocked.Increment(ref _generation);
        var queue = _queue;
        var thread = new Thread(() => ProcessLoop(queue, generation))
        {
            IsBackground = true,
            Name = $"QB-STA-Worker-{generation}"
        };
        if (OperatingSystem.IsWindows())
        {
            thread.SetApartmentState(ApartmentState.STA);
        }
        _staThread = thread;
        thread.Start();
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
            Interlocked.Increment(ref _restarts);

            var old = _queue;
            try
            {
                old.CompleteAdding();
                // Don't wait — the old thread may be hung. Let it die naturally.
                _staThread = null;
            }
            catch { }

            // Jobs still waiting in the old queue would never be processed.
            while (old.TryTake(out var orphan))
            {
                orphan.Tcs.TrySetException(new InvalidOperationException("QB worker restarted before this request was sent; it was not executed."));
            }

            _queue = new BlockingCollection<QbJob>();
            _connected = false;
            _busy = false;
            _hostInfo = null;
            SetError("Restarting...");
            Start();
        }
    }

    private bool IsCurrent(int generation) => Volatile.Read(ref _generation) == generation;

    private void SetError(string? message)
    {
        _lastError = message;
        if (message != null) _lastErrorTime = DateTime.UtcNow;
    }

    private void ProcessLoop(BlockingCollection<QbJob> queue, int generation)
    {
        var appName = _options.AppName;
        var appId = _options.AppID;

        // Multi-user coexistence: when QuickBooks already has the company file
        // open (e.g. a human in Multi-User Mode), the relay must ATTACH to that
        // open file by passing an EMPTY path. Passing an explicit QbFilePath
        // makes QB try to open THAT file in its own default (single-user) mode,
        // which either single-locks the file (if QB was closed) or collides
        // with the already-open multi-user file ("opened in a mode other than
        // the one specified"). Empty path = use whatever file QB has open, in
        // its current mode. Set AttachToOpenFile=false only for unattended runs
        // where the relay should auto-open a closed file (always single-user).
        var attachToOpenFile = _options.AttachToOpenFile;
        var sessionPath = attachToOpenFile ? "" : _options.QbFilePath;

        // BeginSession open mode: 0=DoNotCare, 1=SingleUser, 2=MultiUser.
        // DoNotCare normally attaches to the open file in its current mode, but
        // some QB builds resolve it to single-user and reject a multi-user
        // file. If running alongside multi-user QuickBooks fails with a mode
        // mismatch, set OpenMode=2 to explicitly join the multi-user session.
        var openMode = _options.OpenMode;

        dynamic? rp = null;
        string? ticket = null;

        try
        {
            // Create the COM object on this STA thread
            var rpType = OperatingSystem.IsWindows() ? Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor") : null;
            if (rpType == null)
            {
                var msg = "QBXMLRP2.RequestProcessor COM object not found. Is the QuickBooks SDK installed?";
                if (IsCurrent(generation)) SetError(msg);
                _logger.LogError(msg);
                LogError("STARTUP", msg);
                FailAllPending(queue, msg);
                return;
            }

            rp = Activator.CreateInstance(rpType);
            if (rp == null)
            {
                var msg = "Failed to create QBXMLRP2.RequestProcessor instance.";
                if (IsCurrent(generation)) SetError(msg);
                _logger.LogError(msg);
                LogError("STARTUP", msg);
                FailAllPending(queue, msg);
                return;
            }

            // Open connection
            rp.OpenConnection2(appId, appName, 1 /* localQBD */);
            _logger.LogInformation("QB connection opened: {AppName}", appName);

            // qbFileOpenDoNotCare (0) + empty sessionPath: attach to the file
            // QuickBooks already has open, in its current mode (see above).
            ticket = rp.BeginSession(sessionPath, openMode);
            if (IsCurrent(generation))
            {
                _connected = true;
                SetError(null);
            }
            _logger.LogInformation("QB session started (attachToOpenFile={Attach}, openMode={Mode})", attachToOpenFile, openMode);

            if (_options.HostQueryOnConnect)
            {
                RunHostQuery(rp, ticket!, generation);
            }

            // Process jobs from the queue
            foreach (var job in queue.GetConsumingEnumerable())
            {
                try
                {
                    // Validate XML well-formedness BEFORE sending to QB
                    // This catches the most common cause of QB crashes (malformed XML)
                    if (!IsWellFormedXml(job.QbXml, out var xmlError))
                    {
                        var msg = $"Malformed XML rejected before sending to QB: {xmlError}";
                        _logger.LogWarning("[{RequestId}] {Message}", job.RequestId, msg);
                        LogError("XML_VALIDATION", msg, job.QbXml, job.RequestId);
                        job.Tcs.TrySetException(new InvalidOperationException(msg));
                        continue;
                    }

                    _lastRequestTime = DateTime.UtcNow;
                    if (IsCurrent(generation)) _busy = true;
                    string response;
                    try
                    {
                        response = rp!.ProcessRequest(ticket, job.QbXml);
                    }
                    finally
                    {
                        if (IsCurrent(generation)) _busy = false;
                    }
                    job.Tcs.TrySetResult(response);
                    // Successful request means the session is healthy
                    if (IsCurrent(generation))
                    {
                        _connected = true;
                        SetError(null);
                    }
                }
                catch (COMException comEx)
                {
                    // Request-level errors (QB rejected THIS request's qbXML —
                    // spec violations, unknown elements, version mismatches) do
                    // NOT poison the session. Tearing the connection down and
                    // re-running BeginSession took ~30s per malformed request
                    // and stalled every queued job behind it. Only genuine
                    // connection/session faults trigger a reconnect.
                    if (QbErrorClassifier.IsRequestLevelError(comEx.HResult, comEx.Message))
                    {
                        _logger.LogWarning("[{RequestId}] QB rejected request (session kept): {Message}", job.RequestId, comEx.Message);
                        LogError("QB_PARSE_REJECT", $"HRESULT 0x{comEx.HResult:X8}: {comEx.Message}", job.QbXml, job.RequestId);
                        job.Tcs.TrySetException(comEx);
                        // Session is healthy — the next queued job proceeds immediately.
                        if (IsCurrent(generation))
                        {
                            _connected = true;
                            SetError(null);
                        }
                        continue;
                    }

                    _logger.LogError(comEx, "[{RequestId}] QB COM exception (HRESULT: 0x{HResult:X8})", job.RequestId, comEx.HResult);
                    LogError("COM_EXCEPTION", $"HRESULT 0x{comEx.HResult:X8}: {comEx.Message}", job.QbXml, job.RequestId);
                    if (IsCurrent(generation))
                    {
                        _connected = false;
                        SetError(comEx.Message);
                    }
                    job.Tcs.TrySetException(comEx);
                    TryReconnect(ref rp, ref ticket, sessionPath, openMode, appId, appName, generation);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[{RequestId}] QB ProcessRequest failed", job.RequestId);
                    LogError("REQUEST_FAILED", ex.Message, job.QbXml, job.RequestId);
                    job.Tcs.TrySetException(ex);
                }
            }
        }
        catch (Exception ex)
        {
            if (IsCurrent(generation))
            {
                SetError(ex.Message);
                _connected = false;
            }
            _logger.LogError(ex, "QB worker thread fatal error");
            LogError("FATAL", ex.ToString());
            FailAllPending(queue, ex.Message);
        }
        finally
        {
            // Cleanup
            if (ticket != null && rp != null)
            {
                try { rp!.EndSession(ticket); } catch { }
            }
            if (rp != null)
            {
                try { rp.CloseConnection(); } catch { }
                try { Marshal.ReleaseComObject(rp); } catch { }
            }
            if (IsCurrent(generation)) _connected = false;
        }
    }

    /// <summary>
    /// Ask QuickBooks which product it is and which qbXML versions it accepts,
    /// for /qb/health. Failures are logged and never affect the session.
    /// </summary>
    private void RunHostQuery(dynamic rp, string ticket, int generation)
    {
        try
        {
            var xml = HostQuery.BuildRequest(_options.HostQueryVersion);
            // Same rule as /qb/request: never send a document that has not
            // passed the XSD (and envelope) check, unless validation is off.
            var outcome = _validation.Check(xml);
            if (outcome.Action == ValidationAction.SchemaUnavailable)
            {
                _logger.LogWarning("HostQuery skipped: Relay:ValidateSchema=enforce but the qbXML schema is not loaded");
                return;
            }
            if (outcome.Result is { Valid: false } check)
            {
                _logger.LogWarning("HostQuery skipped: request failed XSD validation: {Errors}", check.Summary());
                return;
            }

            string response = rp.ProcessRequest(ticket, xml);
            var info = HostQuery.ParseResponse(response);
            if (info == null)
            {
                _logger.LogWarning("HostQuery returned no usable HostRet");
                return;
            }
            if (IsCurrent(generation)) _hostInfo = info;
            _logger.LogInformation("QuickBooks: {Product} {Major}.{Minor}, qbXML up to {Version}, file mode {Mode}",
                info.ProductName, info.MajorVersion, info.MinorVersion, info.MaxQbxmlVersion, info.QbFileMode);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "HostQuery failed (session kept)");
            LogError("HOSTQUERY_FAILED", ex.Message);
        }
    }

    private void TryReconnect(ref dynamic? rp, ref string? ticket, string sessionPath, int openMode, string appId, string appName, int generation)
    {
        _logger.LogWarning("Attempting QB reconnect...");

        // Cleanup old connection
        if (ticket != null && rp != null)
        {
            try { rp!.EndSession(ticket); } catch { }
        }
        if (rp != null)
        {
            try { rp.CloseConnection(); } catch { }
            try { Marshal.ReleaseComObject(rp); } catch { }
        }
        rp = null;
        ticket = null;

        Thread.Sleep(2000); // Brief pause before reconnecting

        try
        {
            var rpType = OperatingSystem.IsWindows() ? Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor") : null;
            if (rpType == null) throw new InvalidOperationException("QBXMLRP2.RequestProcessor COM object not found.");
            rp = Activator.CreateInstance(rpType);
            rp!.OpenConnection2(appId, appName, 1);
            ticket = rp.BeginSession(sessionPath, openMode);
            if (IsCurrent(generation))
            {
                _connected = true;
                SetError(null);
            }
            _logger.LogInformation("QB reconnected successfully");
            if (_options.HostQueryOnConnect)
            {
                RunHostQuery(rp, ticket!, generation);
            }
        }
        catch (Exception ex)
        {
            if (IsCurrent(generation))
            {
                SetError($"Reconnect failed: {ex.Message}");
                _connected = false;
            }
            _logger.LogError(ex, "QB reconnect failed");
            LogError("RECONNECT_FAILED", ex.Message);
        }
    }

    private static bool IsWellFormedXml(string xml, out string error)
    {
        error = "";
        try
        {
            var doc = new XmlDocument { XmlResolver = null };
            doc.LoadXml(xml);
            return true;
        }
        catch (XmlException ex)
        {
            error = $"Line {ex.LineNumber}, Position {ex.LinePosition}: {ex.Message}";
            return false;
        }
    }

    private void LogError(string category, string message, string? requestXml = null, string? requestId = null)
    {
        try
        {
            var id = string.IsNullOrEmpty(requestId) ? "" : $" [{requestId}]";
            var entry = $"[{DateTime.UtcNow:o}] [{category}]{id} {message}\n";
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

    private static void FailAllPending(BlockingCollection<QbJob> queue, string error)
    {
        try
        {
            while (queue.TryTake(out var job))
            {
                job.Tcs.TrySetException(new Exception(error));
            }
        }
        catch (ObjectDisposedException) { }
    }

    /// <summary>
    /// Enqueue a qbXML request from any thread. Returns the response asynchronously.
    /// </summary>
    public Task<string> ProcessRequestAsync(string qbXml, string requestId)
    {
        var job = new QbJob
        {
            QbXml = qbXml,
            RequestId = requestId,
            Tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously),
        };
        try
        {
            _queue.Add(job);
        }
        catch (InvalidOperationException)
        {
            // The queue was completed by a concurrent Restart(); the request was not sent.
            job.Tcs.TrySetException(new InvalidOperationException("QB worker is restarting; the request was not sent."));
        }
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
    public required string RequestId { get; init; }
    public required TaskCompletionSource<string> Tcs { get; init; }
}
