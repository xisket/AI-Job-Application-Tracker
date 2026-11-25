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
        limit.MaxRequestBodySize = context.Request.Path == "/api/application-imports/preview"
            ? ApplicationSpreadsheet.MaxFileSize + 1024 * 1024 : 1_000_000;
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

app.MapPost("/api/application-imports/preview", PreviewApplicationImport)
    .WithTags("Applications")
    .Accepts<SpreadsheetUpload>("multipart/form-data")
    .Produces<List<SpreadsheetRow>>()
    .ProducesProblem(400)
    .ProducesProblem(413)
    .ProducesProblem(422);

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
app.MapGet("/api/ai/activity", (long? before, ApplicationStore store) => store.ListOllamaActivity(before))
    .WithTags("Local AI");
app.MapGet("/api/ai/activity/{id:long}", (long id, ApplicationStore store) =>
    store.FindOllamaActivity(id) is { } entry ? Results.Ok(entry) : Results.NotFound())
    .WithTags("Local AI")
    .Produces<OllamaActivityDetail>()
    .ProducesProblem(404);
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

static async Task<IResult> PreviewApplicationImport(HttpRequest request, CancellationToken cancel)
{
    if (!request.HasFormContentType)
        return Results.Problem("Upload a spreadsheet as multipart form data.", statusCode: 400);
    try
    {
        var form = await request.ReadFormAsync(cancel);
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0)
            return Results.Problem("Choose a spreadsheet to preview.", statusCode: 400);
        if (file.Length > ApplicationSpreadsheet.MaxFileSize)
            return Results.Problem("Choose a spreadsheet under 10 MB.", statusCode: 413);
        await using var stream = file.OpenReadStream();
        return Results.Ok(ApplicationSpreadsheet.Read(stream, file.FileName, cancel));
    }
    catch (SpreadsheetImportException error)
    {
        return Results.Problem(error.Message, statusCode: 422);
    }
    catch (Exception error) when (error is InvalidDataException or FormatException or
        Microsoft.VisualBasic.FileIO.MalformedLineException or DocumentFormat.OpenXml.Packaging.OpenXmlPackageException or System.Xml.XmlException)
    {
        return Results.Problem("The spreadsheet could not be read. Check the format and try again.", statusCode: 422);
    }
}

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
record SpreadsheetUpload(IFormFile File);
record ApiError(string Error);

