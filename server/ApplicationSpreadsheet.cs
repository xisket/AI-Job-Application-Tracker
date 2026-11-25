using System.Globalization;
using System.IO.Compression;
using System.Text;
using ClosedXML.Excel;
using Microsoft.VisualBasic.FileIO;

sealed record SpreadsheetRow(int Row, string Applied, string ContactEmail, string ContactPhoneNumber,
    string Company, string Role, string Url, string ResumeName, string[] Notes, string? Error);

sealed class SpreadsheetImportException(string message) : Exception(message);

static class ApplicationSpreadsheet
{
    public const long MaxFileSize = 10 * 1024 * 1024;
    private static readonly string[] Headers =
    [
        "Application Date", "Contact Email", "Contact Phone Number", "Company Name",
        "Job Title", "Job Url", "Resume Name", "Question And Answers"
    ];
    private static readonly CultureInfo ExportCulture = CultureInfo.GetCultureInfo("en-US");
    private static readonly string[] DateFormats = ["M/d/yyyy", "M/d/yy", "yyyy-MM-dd"];
    private static readonly string[] TimeFormats = ["H:mm", "H:mm:ss", "h:mm tt", "h:mm:ss tt"];

    public static List<SpreadsheetRow> Read(Stream stream, string filename, CancellationToken cancel)
    {
        if (Path.GetExtension(filename).Equals(".csv", StringComparison.OrdinalIgnoreCase))
            return ReadCsv(stream, cancel);
        if (Path.GetExtension(filename).Equals(".xlsx", StringComparison.OrdinalIgnoreCase))
            return ReadWorkbook(stream, cancel);
        throw new SpreadsheetImportException("Choose a CSV or Excel (.xlsx) file.");
    }

    private static List<SpreadsheetRow> ReadCsv(Stream stream, CancellationToken cancel)
    {
        foreach (var delimiter in new[] { ";", ",", "\t" })
        {
            stream.Position = 0;
            using var parser = new TextFieldParser(stream, Encoding.UTF8, detectEncoding: true, leaveOpen: true);
            parser.SetDelimiters(delimiter);
            var header = parser.ReadFields();
            if (header is null || FindColumns(header) is not { } columns) continue;

            var rows = new List<SpreadsheetRow>();
            while (!parser.EndOfData)
            {
                cancel.ThrowIfCancellationRequested();
                var row = (int)parser.LineNumber;
                var values = parser.ReadFields() ?? [];
                if (values.Any(value => !string.IsNullOrWhiteSpace(value)))
                    rows.Add(Map(row, index => index < values.Length ? values[index] : "", columns));
            }
            return rows;
        }
        throw MissingHeaders();
    }

    private static List<SpreadsheetRow> ReadWorkbook(Stream stream, CancellationToken cancel)
    {
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read, leaveOpen: true))
        {
            if (archive.Entries.Sum(entry => entry.Length) > 100 * 1024 * 1024)
                throw new SpreadsheetImportException("The expanded workbook is too large. Split it into smaller files.");
        }
        stream.Position = 0;
        using var workbook = new XLWorkbook(stream);
        foreach (var sheet in workbook.Worksheets)
        {
            var first = sheet.FirstRowUsed();
            if (first is null) continue;
            var header = Enumerable.Range(1, first.LastCellUsed()!.Address.ColumnNumber)
                .Select(index => first.Cell(index).CachedValue.ToString(ExportCulture)).ToArray();
            if (FindColumns(header) is not { } columns) continue;

            var rows = new List<SpreadsheetRow>();
            foreach (var row in sheet.RowsUsed().Where(row => row.RowNumber() > first.RowNumber()))
            {
                cancel.ThrowIfCancellationRequested();
                string ReadCell(int index)
                {
                    var cell = row.Cell(index + 1);
                    var value = cell.CachedValue;
                    if (index == columns[5] && cell.HasHyperlink && cell.GetHyperlink().ExternalAddress is { IsAbsoluteUri: true } link)
                        return link.AbsoluteUri;
                    if (index == columns[0] && value.IsDateTime)
                        return FormatDate(value.GetDateTime());
                    if (index == columns[0] && value.IsNumber && value.GetNumber() is >= 1 and < 2958466)
                        return FormatDate(DateTime.FromOADate(value.GetNumber()));
                    return value.ToString(ExportCulture);
                }
                if (columns.Any(index => index >= 0 && !string.IsNullOrWhiteSpace(ReadCell(index))))
                    rows.Add(Map(row.RowNumber(), ReadCell, columns));
            }
            return rows;
        }
        throw MissingHeaders();
    }

    // The contact and resume columns are optional. The application columns identify the sheet.
    private static int[]? FindColumns(string[] header)
    {
        var columns = Headers.Select(name => Array.FindIndex(header, cell =>
            cell.Trim().Equals(name, StringComparison.OrdinalIgnoreCase))).ToArray();
        return columns[0] >= 0 && columns[3] >= 0 && columns[4] >= 0 && columns[5] >= 0
            ? columns
            : null;
    }

    private static SpreadsheetRow Map(int row, Func<int, string> read, int[] columns)
    {
        string Cell(int index) => columns[index] < 0 ? "" : read(columns[index]).Trim();
        var sourceDate = Cell(0);
        var applied = ParseDate(sourceDate);
        var notes = Cell(7).Split('|', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        return new(row, applied ?? sourceDate, Cell(1), Cell(2), Cell(3), Cell(4), Cell(5), Cell(6), notes,
            applied is null ? "Application Date is missing or unreadable." : null);
    }

    private static string? ParseDate(string text)
    {
        if (DateTime.TryParseExact(text, DateFormats, ExportCulture, DateTimeStyles.None, out var date))
            return date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        if (text.Contains('T') && DateTimeOffset.TryParseExact(text,
            ["yyyy-MM-dd'T'HH:mmK", "yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"],
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var timestamp))
        {
            var format = text.EndsWith('Z') || text.IndexOfAny(['+', '-'], 10) >= 0
                ? "yyyy-MM-dd'T'HH:mm:sszzz" : "yyyy-MM-dd'T'HH:mm:ss";
            return timestamp.ToString(format, CultureInfo.InvariantCulture);
        }

        foreach (var day in DateFormats)
        foreach (var time in TimeFormats)
            if (DateTime.TryParseExact(text, day + " " + time, ExportCulture, DateTimeStyles.AllowWhiteSpaces, out date))
                return date.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
        return null;
    }

    private static string FormatDate(DateTime date) => date.ToString(
        date.TimeOfDay == TimeSpan.Zero ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);

    private static SpreadsheetImportException MissingHeaders() =>
        new("The file needs Application Date, Company Name, Job Title, and Job Url columns.");
}
