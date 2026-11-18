using System.Text;
using System.Text.RegularExpressions;

namespace QuickBooksVueRelay;

/// <summary>Classifies errors raised by QBXMLRP2.ProcessRequest.</summary>
public static class QbErrorClassifier
{
    /// <summary>QB_E_QBXML: "There was an error when parsing the provided XML text stream".</summary>
    public const uint QbXmlParseHResult = 0x80040400;

    /// <summary>
    /// QBXMLRP2 raises COM errors both for request-level problems (the qbXML is
    /// unparseable or uses an element QuickBooks does not know) and for genuine
    /// session faults (invalid ticket, dropped connection). Request-level errors
    /// are deterministic client bugs: the session stays valid and must be kept,
    /// because re-running BeginSession takes ~30s and stalls every queued job.
    /// The message needles cover localized and variant phrasings.
    /// </summary>
    public static bool IsRequestLevelError(int hresult, string? message)
    {
        if (unchecked((uint)hresult) == QbXmlParseHResult) return true;

        var m = (message ?? "").ToLowerInvariant();
        return m.Contains("parsing the provided xml")
            || m.Contains("not well-formed")
            || m.Contains("could not be parsed")
            || m.Contains("xml text stream")
            || m.Contains("unsupported version");
    }
}

/// <summary>Correlation ids for request logging.</summary>
public static partial class RequestIds
{
    public const string HeaderName = "X-Request-Id";

    [GeneratedRegex("^[A-Za-z0-9._:-]{1,128}$")]
    private static partial Regex SafeId();

    /// <summary>
    /// Use the caller's X-Request-Id when it is short and made of safe
    /// characters (it is written to logs); otherwise generate one.
    /// </summary>
    public static string Resolve(string? header)
    {
        var h = header?.Trim();
        return !string.IsNullOrEmpty(h) && SafeId().IsMatch(h) ? h : NewId();
    }

    public static string NewId() => Guid.NewGuid().ToString("N");
}

/// <summary>Thrown when a request body exceeds Relay:MaxRequestBodyBytes.</summary>
public sealed class PayloadTooLargeException : Exception
{
    public PayloadTooLargeException(long limit)
        : base($"Request body exceeds the {limit}-byte limit (Relay:MaxRequestBodyBytes)")
    {
        Limit = limit;
    }

    public long Limit { get; }
}

/// <summary>Reads a request body without letting a client make the relay buffer unbounded data.</summary>
public static class BoundedBody
{
    /// <param name="declaredLength">Content-Length, or a negative value when unknown (chunked).</param>
    public static async Task<string> ReadAsStringAsync(Stream body, long declaredLength, long maxBytes, Encoding? encoding, CancellationToken ct = default)
    {
        if (declaredLength > maxBytes) throw new PayloadTooLargeException(maxBytes);

        var initial = declaredLength > 0 ? (int)declaredLength : 8192;
        using var buffer = new MemoryStream(initial);
        var chunk = new byte[81920];
        long total = 0;
        int read;
        while ((read = await body.ReadAsync(chunk.AsMemory(0, chunk.Length), ct).ConfigureAwait(false)) > 0)
        {
            total += read;
            if (total > maxBytes) throw new PayloadTooLargeException(maxBytes);
            buffer.Write(chunk, 0, read);
        }

        return Decode(buffer.GetBuffer(), (int)buffer.Length, encoding ?? Encoding.UTF8);
    }

    private static string Decode(byte[] data, int length, Encoding encoding)
    {
        // Honour a UTF-8 byte order mark regardless of the declared charset.
        if (length >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF)
        {
            return Encoding.UTF8.GetString(data, 3, length - 3);
        }
        return encoding.GetString(data, 0, length);
    }
}
