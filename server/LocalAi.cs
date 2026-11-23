using System.Text.Json;

sealed record AiRequest(string? System, string? Prompt, int? MaxTokens);
sealed record AiStatus(bool Configured);
sealed record AiCompletion(string Text);

sealed class LocalAi(HttpClient client, IConfiguration configuration)
{
    private string? Model => configuration["OLLAMA_MODEL"]?.Trim();
    public bool Configured => !string.IsNullOrEmpty(Model);

    public async Task<IResult> Complete(AiRequest input, CancellationToken cancel)
    {
        var model = Model;
        if (string.IsNullOrEmpty(model))
            return Results.Problem("Set OLLAMA_MODEL and restart the API.", statusCode: 503);
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
                return Results.Problem("Check that OLLAMA_MODEL names an installed model.", statusCode: 502);
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
