using Microsoft.Data.Sqlite;

sealed record OllamaActivitySummary(long Id, string Model, string Feature, string Started,
    string? Finished, string Status, string PromptPreview);
sealed record OllamaActivityDetail(long Id, string Model, string Feature, string Started, string? Finished,
    string Status, string SystemPrompt, string UserPrompt, int MaxTokens, int? HttpStatus, string? Response, string? Error);
sealed record OllamaActivityPage(List<OllamaActivitySummary> Entries, long? NextBefore);

sealed partial class ApplicationStore
{
    public long StartOllamaActivity(string model, string feature, string systemPrompt, string userPrompt, int maxTokens)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO ollama_activity (model, feature, started, status, system_prompt, user_prompt, max_tokens)
            VALUES ($model, $feature, $started, 'Running', $system, $prompt, $tokens)
            RETURNING id;
            """;
        command.Parameters.AddWithValue("$model", model);
        command.Parameters.AddWithValue("$feature", feature);
        command.Parameters.AddWithValue("$started", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$system", systemPrompt);
        command.Parameters.AddWithValue("$prompt", userPrompt);
        command.Parameters.AddWithValue("$tokens", maxTokens);
        return (long)command.ExecuteScalar()!;
    }

    public void FinishOllamaActivity(long id, string status, int? httpStatus, string? response, string? error)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE ollama_activity
            SET finished = $finished, status = $status, http_status = $http, response = $response, error = $error
            WHERE id = $id;
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$finished", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$status", status);
        command.Parameters.AddWithValue("$http", (object?)httpStatus ?? DBNull.Value);
        command.Parameters.AddWithValue("$response", (object?)response ?? DBNull.Value);
        command.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    public OllamaActivityPage ListOllamaActivity(long? before)
    {
        const int pageSize = 25;
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, model, feature, started, finished, status, substr(user_prompt, 1, 160)
            FROM ollama_activity WHERE id < $before ORDER BY id DESC LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$before", before ?? long.MaxValue);
        command.Parameters.AddWithValue("$limit", pageSize + 1);
        using var reader = command.ExecuteReader();
        var entries = new List<OllamaActivitySummary>();
        while (reader.Read())
            entries.Add(new(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                OptionalText(reader, 4), reader.GetString(5), reader.GetString(6)));
        if (entries.Count <= pageSize) return new(entries, null);
        entries.RemoveAt(pageSize);
        return new(entries, entries[^1].Id);
    }

    public OllamaActivityDetail? FindOllamaActivity(long id)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, model, feature, started, finished, status, system_prompt, user_prompt, max_tokens,
                   http_status, response, error FROM ollama_activity WHERE id = $id;
            """;
        command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader();
        return reader.Read() ? new(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
            OptionalText(reader, 4), reader.GetString(5), reader.GetString(6), reader.GetString(7), reader.GetInt32(8),
            reader.IsDBNull(9) ? null : reader.GetInt32(9), OptionalText(reader, 10), OptionalText(reader, 11)) : null;
    }

    private static string? OptionalText(SqliteDataReader reader, int column) =>
        reader.IsDBNull(column) ? null : reader.GetString(column);
}
