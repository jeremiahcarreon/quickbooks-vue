using System.Xml;
using System.Xml.Schema;
using Microsoft.Extensions.Logging;

namespace QuickBooksVueRelay;

public sealed record XsdValidationError(int Line, int Column, string Message, string Severity);

public sealed record XsdValidationResult(bool Valid, IReadOnlyList<XsdValidationError> Errors, bool Truncated = false)
{
    /// <summary>One line per error, e.g. "line 1, column 82: The element ...".</summary>
    public string Summary(int max = 5) =>
        string.Join("; ", Errors.Take(max).Select(e => $"line {e.Line}, column {e.Column}: {e.Message}"))
        + (Errors.Count > max || Truncated ? " (more errors omitted)" : "");
}

/// <summary>Thrown when the qbXML XSDs cannot be found or do not compile.</summary>
public sealed class SchemaLoadException : Exception
{
    public SchemaLoadException(string message, Exception? inner = null) : base(message, inner) { }
}

/// <summary>
/// Validates qbXML documents against the Intuit qbXML XSD (QBUqbxmlops170.xsd and
/// the files it includes) using System.Xml.Schema. The XSDs are not distributed
/// with the relay; they are copied from the QuickBooks SDK into SchemaDir.
/// </summary>
public sealed class QbxmlSchemaValidator
{
    public const int DefaultMaxErrors = 25;

    private readonly XmlSchemaSet _schemas;
    private readonly object _lock = new();

    private QbxmlSchemaValidator(XmlSchemaSet schemas, string schemaPath)
    {
        _schemas = schemas;
        SchemaPath = schemaPath;
    }

    public string SchemaPath { get; }

    /// <summary>Number of global elements in the compiled schema (a sanity figure for health output).</summary>
    public int GlobalElementCount => _schemas.GlobalElements.Count;

    public static QbxmlSchemaValidator Load(string schemaDir, string entryFile = RelayOptions.DefaultSchemaFile)
    {
        var dir = Path.GetFullPath(schemaDir);
        var entry = Path.Combine(dir, entryFile);
        if (!File.Exists(entry))
        {
            throw new SchemaLoadException(
                $"qbXML schema not found at '{entry}'. Copy {entryFile} and the files it includes " +
                "(QBUqbxml170.xsd, QBUqbxmlso170.xsd, qbxmltypes170.xsd) from the QuickBooks SDK into " +
                $"'{dir}', or point Relay:SchemaDir at the folder that holds them.");
        }

        var errors = new List<string>();
        var set = new XmlSchemaSet { XmlResolver = new LocalDirectoryResolver(dir) };
        // Warnings count too: a failed xsd:include is only a warning to
        // XmlSchemaSet, but it leaves part of the schema missing.
        set.ValidationEventHandler += (_, e) => errors.Add(e.Message);

        try
        {
            var readerSettings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            using (var reader = XmlReader.Create(entry, readerSettings))
            {
                set.Add(null, reader);
            }
            set.Compile();
        }
        catch (Exception ex) when (ex is XmlException or XmlSchemaException or IOException or UnauthorizedAccessException)
        {
            throw new SchemaLoadException($"qbXML schema '{entry}' could not be loaded: {ex.Message}", ex);
        }

        if (errors.Count > 0)
        {
            throw new SchemaLoadException($"qbXML schema '{entry}' did not compile: {string.Join("; ", errors.Take(5))}");
        }
        if (set.GlobalElements.Count == 0)
        {
            throw new SchemaLoadException($"qbXML schema '{entry}' declares no elements.");
        }
        return new QbxmlSchemaValidator(set, entry);
    }

    /// <summary>
    /// Validate a qbXML document. Malformed XML is reported as an error (never thrown).
    /// Elements the schema does not know are errors, not warnings.
    /// </summary>
    public XsdValidationResult Validate(string? xml, int maxErrors = DefaultMaxErrors)
    {
        var errors = new List<XsdValidationError>();
        var truncated = false;
        if (string.IsNullOrWhiteSpace(xml))
        {
            errors.Add(new XsdValidationError(0, 0, "Document is empty", "Error"));
            return new XsdValidationResult(false, errors);
        }

        void Add(int line, int column, string message, string severity)
        {
            if (errors.Count >= maxErrors)
            {
                truncated = true;
                return;
            }
            errors.Add(new XsdValidationError(line, column, message, severity));
        }

        var settings = new XmlReaderSettings
        {
            ValidationType = ValidationType.Schema,
            Schemas = _schemas,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersFromEntities = 1024,
        };
        settings.ValidationFlags |= XmlSchemaValidationFlags.ReportValidationWarnings;
        settings.ValidationFlags &= ~XmlSchemaValidationFlags.ProcessInlineSchema;
        settings.ValidationFlags &= ~XmlSchemaValidationFlags.ProcessSchemaLocation;
        settings.ValidationEventHandler += (_, e) =>
        {
            // A "no schema information" warning means an undeclared element slipped
            // through lax processing; for qbXML that is as fatal as an error.
            Add(e.Exception?.LineNumber ?? 0, e.Exception?.LinePosition ?? 0, e.Message,
                e.Severity == XmlSeverityType.Error ? "Error" : "Warning");
        };

        // The compiled schema set is shared; serialise use of it. Validation takes
        // a few milliseconds and QuickBooks processes one request at a time anyway.
        lock (_lock)
        {
            try
            {
                using var reader = XmlReader.Create(new StringReader(xml), settings);
                while (reader.Read())
                {
                }
            }
            catch (XmlException ex)
            {
                Add(ex.LineNumber, ex.LinePosition, $"Malformed XML: {ex.Message}", "Error");
            }
        }

        return new XsdValidationResult(errors.Count == 0, errors, truncated);
    }

    /// <summary>Resolves xsd:include only to files inside the schema directory.</summary>
    private sealed class LocalDirectoryResolver : XmlUrlResolver
    {
        private readonly string _root;

        public LocalDirectoryResolver(string root)
        {
            _root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        }

        public override object? GetEntity(Uri absoluteUri, string? role, Type? ofObjectToReturn)
        {
            if (!absoluteUri.IsFile)
            {
                throw new XmlException($"Schema reference '{absoluteUri}' is not a local file; refusing to fetch it.");
            }
            var path = Path.GetFullPath(absoluteUri.LocalPath);
            if (!path.StartsWith(_root, StringComparison.OrdinalIgnoreCase))
            {
                throw new XmlException($"Schema reference '{path}' is outside the schema directory.");
            }
            return base.GetEntity(absoluteUri, role, ofObjectToReturn);
        }
    }
}

/// <summary>What the HTTP layer should do with a request after XSD validation.</summary>
public enum ValidationAction
{
    /// <summary>Forward to QuickBooks.</summary>
    Forward,
    /// <summary>Reject with 400 (enforce mode, invalid document).</summary>
    Reject,
    /// <summary>Reject with 500: enforce mode is on but no schema is loaded.</summary>
    SchemaUnavailable,
}

public sealed record ValidationOutcome(ValidationAction Action, XsdValidationResult? Result);

/// <summary>
/// Applies Relay:ValidateSchema. Holds the compiled schema (or the reason it
/// could not be loaded) for the lifetime of the process.
/// </summary>
public sealed class SchemaValidationService
{
    public SchemaValidationService(SchemaValidationMode mode, QbxmlSchemaValidator? validator, string schemaPath, string? loadError)
    {
        Mode = mode;
        Validator = validator;
        SchemaPath = schemaPath;
        LoadError = loadError;
    }

    public SchemaValidationMode Mode { get; }
    public QbxmlSchemaValidator? Validator { get; }
    public string SchemaPath { get; }
    public string? LoadError { get; }
    public bool SchemaLoaded => Validator != null;

    /// <summary>Load the schema unless validation is off. Never throws; failures are kept in LoadError.</summary>
    public static SchemaValidationService Create(RelayOptions options, ILogger? logger = null)
    {
        var path = Path.Combine(options.SchemaDir, options.SchemaFile);
        if (options.ValidateSchema == SchemaValidationMode.Off)
        {
            logger?.LogInformation("XSD validation is off (Relay:ValidateSchema=off)");
            return new SchemaValidationService(SchemaValidationMode.Off, null, path, null);
        }

        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var validator = QbxmlSchemaValidator.Load(options.SchemaDir, options.SchemaFile);
            logger?.LogInformation("Loaded qbXML schema {Path} ({Elements} elements, {Ms} ms); validation mode {Mode}",
                validator.SchemaPath, validator.GlobalElementCount, sw.ElapsedMilliseconds, options.ValidateSchema);
            return new SchemaValidationService(options.ValidateSchema, validator, validator.SchemaPath, null);
        }
        catch (SchemaLoadException ex)
        {
            if (options.ValidateSchema == SchemaValidationMode.Enforce)
            {
                logger?.LogError("Relay:ValidateSchema=enforce but the schema could not be loaded; every request will be refused until this is fixed. {Error}", ex.Message);
            }
            else
            {
                logger?.LogWarning("XSD validation is unavailable, requests are forwarded unvalidated: {Error}", ex.Message);
            }
            return new SchemaValidationService(options.ValidateSchema, null, path, ex.Message);
        }
    }

    public ValidationOutcome Check(string xml)
    {
        if (Mode == SchemaValidationMode.Off) return new ValidationOutcome(ValidationAction.Forward, null);
        if (Validator == null)
        {
            return new ValidationOutcome(
                Mode == SchemaValidationMode.Enforce ? ValidationAction.SchemaUnavailable : ValidationAction.Forward, null);
        }

        var result = Validator.Validate(xml);
        // The XSD cannot express the <?qbxml version?> instruction QuickBooks needs.
        var envelope = QbxmlEnvelope.Check(xml);
        if (envelope.Count > 0)
        {
            result = new XsdValidationResult(false, result.Errors.Concat(envelope).ToList(), result.Truncated);
        }
        if (!result.Valid && Mode == SchemaValidationMode.Enforce) return new ValidationOutcome(ValidationAction.Reject, result);
        return new ValidationOutcome(ValidationAction.Forward, result);
    }
}
