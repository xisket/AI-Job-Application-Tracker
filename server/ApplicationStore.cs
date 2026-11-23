using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

sealed record ApplicationRecord(JsonElement Job, [property: JsonPropertyName("etag")] string ETag);

sealed class ApplicationStore
{
    private readonly string connectionString;
    private static readonly string[] TextFields =
    [
        "role", "company", "location", "arrangement", "salary", "deadline", "requirements", "url",
        "description", "posted", "applied", "notes", "next", "due", "interview", "stage", "updated"
    ];

    public ApplicationStore(string path)
    {
        path = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = path }.ToString();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS applications (
                id TEXT PRIMARY KEY,
                job TEXT NOT NULL,
                version TEXT NOT NULL
            );
            """;
        command.ExecuteNonQuery();
    }

    public static bool TryValidate(JsonElement job, out Guid id)
    {
        id = default;
        return job.ValueKind == JsonValueKind.Object &&
            IsText(job, "id") && Guid.TryParseExact(job.GetProperty("id").GetString(), "D", out id) &&
            TextFields.All(field => IsText(job, field)) &&
            job.GetProperty("stage").GetString() is
                ("Saved" or "Applied" or "Screening" or "Interviewing" or "Offer" or "Accepted" or "Rejected" or "Withdrawn") &&
            (!job.TryGetProperty("created", out var created) || created.ValueKind == JsonValueKind.String) &&
            job.TryGetProperty("history", out var history) && history.ValueKind == JsonValueKind.Array &&
            history.EnumerateArray().All(entry => entry.ValueKind == JsonValueKind.Object &&
                IsText(entry, "id") && IsText(entry, "date") && IsText(entry, "kind") && IsText(entry, "text")) &&
            (!job.TryGetProperty("reminders", out var reminders) || reminders.ValueKind == JsonValueKind.Object &&
                reminders.EnumerateObject().All(reminder => ValidReminder(reminder.Value)));
    }

    private static bool ValidReminder(JsonElement reminder) =>
        reminder.ValueKind == JsonValueKind.Object &&
        (!reminder.TryGetProperty("done", out var done) || done.ValueKind is JsonValueKind.True or JsonValueKind.False) &&
        (!reminder.TryGetProperty("snoozed", out var snoozed) || snoozed.ValueKind == JsonValueKind.String);

    private static bool IsText(JsonElement value, string key) =>
        value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String;

    public List<ApplicationRecord> List()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT job, version FROM applications";
        using var reader = command.ExecuteReader();
        var records = new List<ApplicationRecord>();
        while (reader.Read()) records.Add(Read(reader));
        return records;
    }

    public ApplicationRecord? Find(Guid id)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT job, version FROM applications WHERE id = $id";
        command.Parameters.AddWithValue("$id", id.ToString());
        using var reader = command.ExecuteReader();
        return reader.Read() ? Read(reader) : null;
    }

    public ApplicationRecord? Create(Guid id, JsonElement job) => Write(id, job,
        "INSERT INTO applications (id, job, version) VALUES ($id, $job, $version) ON CONFLICT (id) DO NOTHING");

    public ApplicationRecord? Update(Guid id, JsonElement job, string version) => Write(id, job,
        "UPDATE applications SET job = $job, version = $version WHERE id = $id AND version = $previous", version);

    public bool Delete(Guid id, string version)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM applications WHERE id = $id AND version = $version";
        command.Parameters.AddWithValue("$id", id.ToString());
        command.Parameters.AddWithValue("$version", version);
        return command.ExecuteNonQuery() == 1;
    }

    private ApplicationRecord? Write(Guid id, JsonElement job, string sql, string? previous = null)
    {
        var version = $"\"{Guid.NewGuid():N}\"";
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$id", id.ToString());
        command.Parameters.AddWithValue("$job", job.GetRawText());
        command.Parameters.AddWithValue("$version", version);
        if (previous is not null) command.Parameters.AddWithValue("$previous", previous);
        return command.ExecuteNonQuery() == 1 ? new ApplicationRecord(job, version) : null;
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }

    private static ApplicationRecord Read(SqliteDataReader reader) =>
        new(JsonSerializer.Deserialize<JsonElement>(reader.GetString(0)), reader.GetString(1));
}

