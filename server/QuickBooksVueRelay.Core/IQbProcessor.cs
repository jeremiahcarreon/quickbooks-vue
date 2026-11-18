namespace QuickBooksVueRelay;

/// <summary>
/// The QuickBooks side of the relay: a serial request processor. Implemented by
/// QbWorker (COM, Windows) and by fakes in tests.
/// </summary>
public interface IQbProcessor
{
    /// <summary>Queue a qbXML request; completes with QuickBooks' response.</summary>
    Task<string> ProcessRequestAsync(string qbXml, string requestId);

    /// <summary>Restart the processing thread (used after a hung call).</summary>
    void Restart();

    bool IsConnected { get; }
    /// <summary>False when the processing thread has exited (e.g. the SDK is missing).</summary>
    bool IsRunning { get; }
    string? LastError { get; }
    DateTime? LastErrorTime { get; }
    DateTime LastRequestTime { get; }
    /// <summary>Requests waiting behind the one QuickBooks is working on.</summary>
    int QueueDepth { get; }
    /// <summary>True while QuickBooks is processing a request.</summary>
    bool IsBusy { get; }
    /// <summary>Result of the last HostQuery, or null if none has succeeded yet.</summary>
    QbHostInfo? HostInfo { get; }
    int Restarts { get; }

    /// <summary>Recent entries of the error log file (GET /qb/errors).</summary>
    string GetRecentErrors(int maxBytes = 20000);
}

/// <summary>Counters for /qb/health. Thread-safe.</summary>
public sealed class RelayStats
{
    private long _total;
    private long _succeeded;
    private long _failed;
    private long _timedOut;
    private long _schemaInvalid;
    private long _schemaRejected;
    private long _tooLarge;
    private long _unauthorized;
    private readonly object _lock = new();

    public DateTime StartedAt { get; } = DateTime.UtcNow;

    public long Total => Interlocked.Read(ref _total);
    public long Succeeded => Interlocked.Read(ref _succeeded);
    public long Failed => Interlocked.Read(ref _failed);
    public long TimedOut => Interlocked.Read(ref _timedOut);
    /// <summary>Requests that failed XSD validation (logged or rejected).</summary>
    public long SchemaInvalid => Interlocked.Read(ref _schemaInvalid);
    /// <summary>Requests rejected with 400 because they failed XSD validation.</summary>
    public long SchemaRejected => Interlocked.Read(ref _schemaRejected);
    public long TooLarge => Interlocked.Read(ref _tooLarge);
    public long Unauthorized => Interlocked.Read(ref _unauthorized);

    public FailureRecord? LastFailure { get; private set; }

    public void Request() => Interlocked.Increment(ref _total);
    public void Success() => Interlocked.Increment(ref _succeeded);
    public void SchemaInvalidSeen() => Interlocked.Increment(ref _schemaInvalid);
    public void UnauthorizedSeen() => Interlocked.Increment(ref _unauthorized);

    public void Failure(int status, string requestId, string message, FailureKind kind = FailureKind.Failed)
    {
        switch (kind)
        {
            case FailureKind.TimedOut: Interlocked.Increment(ref _timedOut); break;
            case FailureKind.SchemaRejected: Interlocked.Increment(ref _schemaRejected); break;
            case FailureKind.TooLarge: Interlocked.Increment(ref _tooLarge); break;
            default: Interlocked.Increment(ref _failed); break;
        }
        lock (_lock)
        {
            LastFailure = new FailureRecord(DateTime.UtcNow, status, requestId, message.Length > 500 ? message[..500] + "..." : message);
        }
    }
}

public enum FailureKind { Failed, TimedOut, SchemaRejected, TooLarge }

public sealed record FailureRecord(DateTime At, int Status, string RequestId, string Message);
