using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.OpenApi;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration["urls"] ??= "http://127.0.0.1:5080";
builder.Services.AddProblemDetails();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo { Title = "AI Job Application Tracker API", Version = "v1" });
    options.OperationFilter<TrackerHeadersOperationFilter>();
});
builder.Services.AddSingleton(new ApplicationStore(
    builder.Configuration["TRACKER_DB_PATH"] ??
    Path.Combine(builder.Environment.ContentRootPath, "data", "applications.db")));
builder.Services.AddHttpClient<PostingImporter>()
    .ConfigurePrimaryHttpMessageHandler(PostingImporter.CreateHandler);
builder.Services.AddHttpClient<LocalAi>(client =>
{
    client.BaseAddress = new Uri(LocalAi.ServerUrl);
    client.Timeout = TimeSpan.FromMinutes(2);
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    UseProxy = false,
    AllowAutoRedirect = false
});

var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseSwagger();
app.UseSwaggerUI(options => options.SwaggerEndpoint("v1/swagger.json", "Tracker API v1"));
app.MapGet("/", () => Results.Redirect("/swagger")).ExcludeFromDescription();
app.Use(async (HttpContext context, RequestDelegate next) =>
{
    if (!context.Request.Path.StartsWithSegments("/api"))
    {
        await next(context);
        return;
    }

    context.Response.Headers.CacheControl = "no-store";
    if (!HttpMethods.IsGet(context.Request.Method) && context.Request.Headers["X-Tracker-Request"] != "1")
    {
        await Results.Problem("The X-Tracker-Request header is required.", statusCode: 403).ExecuteAsync(context);
        return;
    }

    if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        limit.MaxRequestBodySize = 1_000_000;
    await next(context);
});

var applications = app.MapGroup("/api/applications").WithTags("Applications");
applications.MapGet("", (ApplicationStore store) => store.List());
applications.MapGet("/{id:guid}", (Guid id, ApplicationStore store, HttpResponse response) =>
    WithVersion(store.Find(id), response))
    .Produces<ApplicationRecord>()
    .ProducesProblem(404);

applications.MapPost("", (JsonElement job, ApplicationStore store, HttpResponse response) =>
{
    if (!ApplicationStore.TryValidate(job, out var id)) return InvalidJob();
    var record = store.Create(id, job);
    if (record is null) return Results.Conflict(new ApiError("An application with this ID already exists."));
    response.Headers.ETag = record.ETag;
    return Results.Created($"/api/applications/{id}", record);
})
    .Produces<ApplicationRecord>(201)
    .ProducesProblem(400)
    .Produces<ApiError>(409);

applications.MapPut("/{id:guid}", (Guid id, JsonElement job, ApplicationStore store, HttpContext context) =>
{
    if (!ApplicationStore.TryValidate(job, out var bodyId) || id != bodyId) return InvalidJob();
    var version = context.Request.Headers.IfMatch.ToString();
    if (version.Length == 0) return MissingVersion();
    var record = store.Update(id, job, version);
    return record is null ? Changed() : WithVersion(record, context.Response);
})
    .Produces<ApplicationRecord>()
    .ProducesProblem(400)
    .ProducesProblem(412)
    .ProducesProblem(428);

applications.MapDelete("/{id:guid}", (Guid id, ApplicationStore store, HttpRequest request) =>
{
    var version = request.Headers.IfMatch.ToString();
    if (version.Length == 0) return MissingVersion();
    return store.Delete(id, version) ? Results.NoContent() : Changed();
})
    .Produces(204)
    .ProducesProblem(412)
    .ProducesProblem(428);

app.MapPost("/api/posting-imports", async (PostingRequest input, PostingImporter importer, CancellationToken cancel) =>
{
    try
    {
        return Results.Ok(await importer.Import(input.Url, cancel));
    }
    catch (Exception error) when (error is PostingException or HttpRequestException or IOException ||
                                  error is OperationCanceledException && !cancel.IsCancellationRequested)
    {
        return Results.UnprocessableEntity(new ApiError(error is PostingException
            ? error.Message
            : "Could not download the posting. Check the link and try again."));
    }
})
    .WithTags("Posting imports")
    .Produces(200, contentType: "application/json")
    .Produces<ApiError>(422);

app.MapGet("/api/ai", (LocalAi ai) => new AiStatus(ai.Configured)).WithTags("Local AI");
app.MapGet("/api/ai/models", (LocalAi ai, CancellationToken cancel) => ai.ListModels(cancel))
    .WithTags("Local AI")
    .Produces<OllamaModels>()
    .ProducesProblem(502)
    .ProducesProblem(504);
app.MapPost("/api/ai/completions", (AiRequest input, LocalAi ai, CancellationToken cancel) => ai.Complete(input, cancel))
    .WithTags("Local AI")
    .Produces<AiCompletion>()
    .ProducesProblem(400)
    .ProducesProblem(502)
    .ProducesProblem(503)
    .ProducesProblem(504);
app.MapGet("/api/settings", (LocalAi ai) => ai.Settings()).WithTags("Settings");
app.MapPut("/api/settings/ollama", (OllamaSettings input, LocalAi ai) => ai.SaveSettings(input))
    .WithTags("Settings")
    .Produces<TrackerSettings>()
    .ProducesProblem(400);
app.Run();

static IResult InvalidJob() => Results.Problem("Invalid application data or ID.", statusCode: 400);
static IResult MissingVersion() => Results.Problem("Supply the application ETag in If-Match.", statusCode: 428);
static IResult Changed() => Results.Problem("This application changed in another window. Refresh the list and try again.", statusCode: 412);

static IResult WithVersion(ApplicationRecord? record, HttpResponse response)
{
    if (record is null) return Results.NotFound();
    response.Headers.ETag = record.ETag;
    return Results.Ok(record);
}

record PostingRequest(string? Url);
record ApiError(string Error);

