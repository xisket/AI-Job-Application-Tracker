using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

sealed record ApplicationRecord(JsonElement Job, [property: JsonPropertyName("etag")] string ETag);

sealed partial class ApplicationStore
{
    private readonly string connectionString;
    public string DatabasePath { get; }
    private const string ReadApplications = """
        SELECT json_set(app.job, '$.notes', '', '$.noteEntries', json(coalesce((
            SELECT json_group_array(json_object(
                'id', note.id, 'text', note.text, 'created', note.created, 'updated', note.updated
            ) ORDER BY note.sort_order, note.id)
            FROM application_notes AS note
            WHERE note.application_id = app.id
        ), '[]')), '$.company', coalesce(company.name, ''),
            '$.companyId', app.company_id, '$.companyLogo', coalesce(company.logo, '')), app.version
        FROM applications AS app
        LEFT JOIN companies AS company ON company.id = app.company_id
        """;
    private static readonly string[] TextFields =
    [
        "role", "company", "location", "arrangement", "salary", "deadline", "requirements", "url",
        "description", "posted", "applied", "notes", "next", "due", "interview", "stage", "updated"
    ];

    public ApplicationStore(string path)
    {
        path = Path.GetFullPath(path);
        DatabasePath = path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = path, ForeignKeys = true }.ToString();
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS companies (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                logo TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS applications (
                id TEXT PRIMARY KEY,
                job TEXT NOT NULL,
                version TEXT NOT NULL,
                company_id TEXT REFERENCES companies(id)
            );
            CREATE TABLE IF NOT EXISTS application_notes (
                application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                text TEXT NOT NULL,
                created TEXT,
                updated TEXT,
                sort_order INTEGER NOT NULL,
                PRIMARY KEY (application_id, id)
            );
            CREATE TABLE IF NOT EXISTS tracker_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ollama_activity (
                id INTEGER PRIMARY KEY,
                model TEXT NOT NULL,
                feature TEXT NOT NULL,
                started TEXT NOT NULL,
                finished TEXT,
                status TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                user_prompt TEXT NOT NULL,
                max_tokens INTEGER NOT NULL,
                http_status INTEGER,
                response TEXT,
                error TEXT
            );
            """;
        command.ExecuteNonQuery();
        MigrateCompanies(connection, transaction);
        MigrateNotes(connection, transaction);
        transaction.Commit();
    }

    private static void MigrateCompanies(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT count(*) FROM pragma_table_info('applications') WHERE name = 'company_id'";
        if ((long)command.ExecuteScalar()! == 0)
        {
            command.CommandText = "ALTER TABLE applications ADD COLUMN company_id TEXT REFERENCES companies(id)";
            command.ExecuteNonQuery();
        }

        command.CommandText = "CREATE INDEX IF NOT EXISTS applications_company_id ON applications(company_id)";
        command.ExecuteNonQuery();
        command.CommandText = """
            SELECT id, coalesce(job ->> 'company', '') FROM applications
            WHERE json_type(job, '$.company') IS NOT NULL
            ORDER BY id
            """;
        var applications = new List<(string Id, string Company)>();
        using (var reader = command.ExecuteReader())
            while (reader.Read()) applications.Add((reader.GetString(0), reader.GetString(1)));

        command.CommandText = "UPDATE applications SET company_id = $company, job = json_remove(job, '$.company') WHERE id = $id";
        var company = command.Parameters.Add("$company", SqliteType.Text);
        var id = command.Parameters.Add("$id", SqliteType.Text);
        foreach (var app in applications)
        {
            company.Value = (object?)SaveCompany(connection, transaction, app.Company) ?? DBNull.Value;
            id.Value = app.Id;
            command.ExecuteNonQuery();
        }
    }

    private static string? SaveCompany(SqliteConnection connection, SqliteTransaction transaction,
        string company, string? logo = null, bool replaceLogo = false)
    {
        var name = company.Trim();
        if (name.Length == 0) return null;
        var id = name.ToUpperInvariant();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO companies (id, name, logo) VALUES ($id, $name, coalesce($logo, ''))
            ON CONFLICT (id) DO UPDATE SET logo = excluded.logo
            WHERE $logo IS NOT NULL AND ($replace OR companies.logo = '')
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$logo", (object?)logo ?? DBNull.Value);
        command.Parameters.AddWithValue("$replace", replaceLogo);
        command.ExecuteNonQuery();
        return id;
    }

    private static void MigrateNotes(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT id, job FROM applications
            WHERE json_type(job, '$.notes') IS NOT NULL OR json_type(job, '$.noteEntries') IS NOT NULL
            """;
        var applications = new List<(string Id, JsonElement Job)>();
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                applications.Add((reader.GetString(0), JsonSerializer.Deserialize<JsonElement>(reader.GetString(1))));

        foreach (var (id, job) in applications)
            SaveNotes(connection, transaction, id, job);

        command.CommandText = """
            UPDATE applications SET job = json_remove(job, '$.notes', '$.noteEntries')
            WHERE json_type(job, '$.notes') IS NOT NULL OR json_type(job, '$.noteEntries') IS NOT NULL
            """;
        command.ExecuteNonQuery();
    }

    public string? ReadOllamaModel()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT value FROM tracker_settings WHERE key = 'ollama_model'";
        return (string?)command.ExecuteScalar();
    }

    public void SetOllamaModel(string? model)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        if (model is null)
        {
            command.CommandText = "DELETE FROM tracker_settings WHERE key = 'ollama_model'";
        }
        else
        {
            command.CommandText = """
                INSERT INTO tracker_settings (key, value) VALUES ('ollama_model', $model)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value
                """;
            command.Parameters.AddWithValue("$model", model);
        }
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
            (!job.TryGetProperty("noteEntries", out var notes) || ValidNotes(notes)) &&
            ValidOptionalLogo(job, "companyLogoUpdate") && ValidOptionalLogo(job, "companyLogoImport") &&
            (!job.TryGetProperty("reminders", out var reminders) || reminders.ValueKind == JsonValueKind.Object &&
                reminders.EnumerateObject().All(reminder => ValidReminder(reminder.Value)));
    }

    private static bool ValidOptionalLogo(JsonElement job, string key)
    {
        if (!job.TryGetProperty(key, out var logo)) return true;
        if (logo.ValueKind != JsonValueKind.String) return false;
        var value = logo.GetString()!;
        if (value.Length == 0) return true;
        if (value.Length <= 4096 && Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme is "http" or "https" && uri.Host.Length > 0 && uri.UserInfo.Length == 0)
            return true;

        var separator = value.IndexOf(',');
        if (separator < 0 || value.Length > 350_000 ||
            value[..separator] is not ("data:image/png;base64" or "data:image/jpeg;base64" or
                "data:image/webp;base64" or "data:image/gif;base64"))
            return false;
        return Convert.TryFromBase64Chars(value.AsSpan(separator + 1), new byte[256 * 1024], out var bytes) && bytes > 0;
    }

    private static bool ValidNotes(JsonElement notes)
    {
        if (notes.ValueKind != JsonValueKind.Array) return false;
        var ids = new HashSet<Guid>();
        return notes.EnumerateArray().All(note => note.ValueKind == JsonValueKind.Object &&
            IsText(note, "id") && Guid.TryParseExact(note.GetProperty("id").GetString(), "D", out var id) && ids.Add(id) &&
            IsText(note, "text") && !string.IsNullOrWhiteSpace(note.GetProperty("text").GetString()) &&
            ValidNoteDate(note, "created") && ValidNoteDate(note, "updated"));
    }

    private static bool ValidNoteDate(JsonElement note, string key) =>
        note.TryGetProperty(key, out var date) && (date.ValueKind == JsonValueKind.Null ||
            date.ValueKind == JsonValueKind.String && date.TryGetDateTimeOffset(out _));

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
        command.CommandText = ReadApplications;
        using var reader = command.ExecuteReader();
        var records = new List<ApplicationRecord>();
        while (reader.Read()) records.Add(Read(reader));
        return records;
    }

    public ApplicationRecord? Find(Guid id)
    {
        using var connection = Open();
        return Find(connection, id.ToString());
    }

    private static ApplicationRecord? Find(SqliteConnection connection, string id, SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = ReadApplications + "\nWHERE app.id = $id";
        command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader();
        return reader.Read() ? Read(reader) : null;
    }

    public ApplicationRecord? Create(Guid id, JsonElement job) => Write(id, job,
        """
        INSERT INTO applications (id, job, version, company_id)
        VALUES ($id, json_remove($job, '$.notes', '$.noteEntries', '$.company', '$.companyId', '$.companyLogo',
            '$.companyLogoImport', '$.companyLogoUpdate'), $version, $company)
        ON CONFLICT (id) DO NOTHING
        """);

    public ApplicationRecord? Update(Guid id, JsonElement job, string version) => Write(id, job,
        """
        UPDATE applications SET job = json_remove($job, '$.notes', '$.noteEntries', '$.company', '$.companyId', '$.companyLogo',
            '$.companyLogoImport', '$.companyLogoUpdate'), version = $version, company_id = $company
        WHERE id = $id AND version = $previous
        """, version);

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
        var applicationId = id.ToString();
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var replaceLogo = job.TryGetProperty("companyLogoUpdate", out var logoUpdate);
        var logo = replaceLogo ? logoUpdate.GetString() :
            job.TryGetProperty("companyLogoImport", out var imported) ? imported.GetString() : null;
        var companyId = SaveCompany(connection, transaction, job.GetProperty("company").GetString()!, logo, replaceLogo);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.Parameters.AddWithValue("$id", applicationId);
        command.Parameters.AddWithValue("$job", job.GetRawText());
        command.Parameters.AddWithValue("$company", (object?)companyId ?? DBNull.Value);
        command.Parameters.AddWithValue("$version", version);
        if (previous is not null) command.Parameters.AddWithValue("$previous", previous);
        if (command.ExecuteNonQuery() != 1) return null;
        SaveNotes(connection, transaction, applicationId, job);
        var record = Find(connection, applicationId, transaction);
        transaction.Commit();
        return record;
    }

    private static void SaveNotes(SqliteConnection connection, SqliteTransaction transaction, string id, JsonElement job)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.Parameters.AddWithValue("$id", id);
        if (job.TryGetProperty("noteEntries", out var notes) && notes.ValueKind == JsonValueKind.Array)
        {
            command.Parameters.AddWithValue("$notes", notes.GetRawText());
            command.CommandText = """
                DELETE FROM application_notes
                WHERE application_id = $id AND id NOT IN (
                    SELECT value ->> 'id' FROM json_each($notes)
                );
                INSERT INTO application_notes (application_id, id, text, created, updated, sort_order)
                SELECT $id, value ->> 'id', value ->> 'text', value ->> 'created', value ->> 'updated', key
                FROM json_each($notes) WHERE true
                ON CONFLICT (application_id, id) DO UPDATE SET
                    text = excluded.text, created = excluded.created,
                    updated = excluded.updated, sort_order = excluded.sort_order
                WHERE text IS NOT excluded.text OR created IS NOT excluded.created
                    OR updated IS NOT excluded.updated OR sort_order IS NOT excluded.sort_order;
                """;
        }
        else if (IsText(job, "notes") && job.GetProperty("notes").GetString() is { } legacyNote &&
                 !string.IsNullOrWhiteSpace(legacyNote))
        {
            command.Parameters.AddWithValue("$text", legacyNote);
            command.CommandText = """
                INSERT INTO application_notes (application_id, id, text, sort_order)
                VALUES ($id, $id, $text, -1)
                ON CONFLICT (application_id, id) DO UPDATE SET text = excluded.text;
                """;
        }
        else
        {
            return;
        }
        command.ExecuteNonQuery();
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

