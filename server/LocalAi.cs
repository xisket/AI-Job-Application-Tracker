using System.Text.Json;

sealed record AiRequest(string? System, string? Prompt, int? MaxTokens);
sealed record AiStatus(bool Configured);
sealed record AiCompletion(string Text);
sealed record OllamaModels(string[] Models);
sealed record OllamaSettings(string? Model);
sealed record TrackerSettings(string DatabasePath, string OllamaUrl, string Model, string? ModelOverride);

sealed class LocalAi(HttpClient client, IConfiguration configuration, ApplicationStore store)
{
    public const string ServerUrl = "http://127.0.0.1:11434";
    private string EnvironmentModel => configuration["OLLAMA_MODEL"]?.Trim() ?? "";
    private string Model => store.ReadOllamaModel() ?? EnvironmentModel;
    public bool Configured => !string.IsNullOrEmpty(Model);

    public TrackerSettings Settings()
    {
        var modelOverride = store.ReadOllamaModel();
        return new(store.DatabasePath, ServerUrl, modelOverride ?? EnvironmentModel, modelOverride);
    }

    public IResult SaveSettings(OllamaSettings input)
    {
        var model = input.Model?.Trim();
        if (model is not null && (model.Length > 256 || model.Any(char.IsWhiteSpace) || model.Any(char.IsControl)))
            return Results.Problem("Enter a model tag of up to 256 characters without spaces.", statusCode: 400);

        store.SetOllamaModel(model);
        return Results.Ok(Settings());
    }

    public async Task<IResult> ListModels(CancellationToken cancel)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromSeconds(4));
        try
        {
            using var response = await client.GetAsync("/api/tags", timeout.Token);
            if (!response.IsSuccessStatusCode)
                return Results.Problem("Ollama could not list the installed models.", statusCode: 502);

            using var result = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token),
                cancellationToken: timeout.Token);
            if (result.RootElement.ValueKind == JsonValueKind.Object &&
                result.RootElement.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Array)
            {
                var names = models.EnumerateArray()
                    .Where(model => model.ValueKind == JsonValueKind.Object &&
                        model.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
                    .Select(model => model.GetProperty("name").GetString()!)
                    .Where(name => !string.IsNullOrWhiteSpace(name))
                    .Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal)
                    .ToArray();
                return Results.Ok(new OllamaModels(names));
            }
        }
        catch (HttpRequestException)
        {
            return Results.Problem("Start Ollama on this computer and check again.", statusCode: 502);
        }
        catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
        {
            return Results.Problem("Ollama did not respond in time.", statusCode: 504);
        }
        catch (JsonException)
        {
            // Ollama responded, but the model list was invalid.
        }
        return Results.Problem("Ollama returned an invalid model list.", statusCode: 502);
    }

    public async Task<IResult> Complete(AiRequest input, CancellationToken cancel)
    {
        var model = Model;
        if (string.IsNullOrEmpty(model))
            return Results.Problem("Choose an Ollama model in Settings or set OLLAMA_MODEL.", statusCode: 503);
        if (input.System is null || input.Prompt is null || input.System.Length + input.Prompt.Length > 250_000)
            return Results.Problem("Invalid local AI request or request is too large.", statusCode: 400);

        try
        {
            using var response = await client.PostAsJsonAsync("/api/chat", new
            {
                model,
                stream = false,
                messages = new[] { new { role = "system", content = input.System }, new { role = "user", content = input.Prompt } },
                options = new { num_predict = Math.Clamp(input.MaxTokens ?? 1000, 100, 2200), temperature = 0 }
            }, cancel);
            if (!response.IsSuccessStatusCode)
                return Results.Problem("Check that the selected Ollama model is installed and supports chat.", statusCode: 502);
            using var result = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancel), cancellationToken: cancel);
            if (result.RootElement.ValueKind == JsonValueKind.Object &&
                result.RootElement.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.Object &&
                message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                return Results.Ok(new AiCompletion(content.GetString()!));
        }
        catch (HttpRequestException)
        {
            return Results.Problem("Start Ollama on this computer and try again.", statusCode: 502);
        }
        catch (OperationCanceledException) when (!cancel.IsCancellationRequested)
        {
            return Results.Problem("Ollama took too long to respond.", statusCode: 504);
        }
        catch (JsonException)
        {
            // Ollama responded, but the response was invalid.
        }
        return Results.Problem("The model returned an invalid response.", statusCode: 502);
    }
}
