using System.Text.Json.Nodes;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

sealed class TrackerHeadersOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var request = context.ApiDescription;
        if (request.RelativePath?.StartsWith("api/", StringComparison.Ordinal) != true ||
            request.HttpMethod is null or "GET")
            return;

        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Tracker-Request",
            In = ParameterLocation.Header,
            Required = true,
            Description = "Send 1 with write requests.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String, Default = JsonValue.Create("1") }
        });
        operation.Responses?.TryAdd("403", new OpenApiResponse { Description = "Missing or invalid X-Tracker-Request header." });

        if (request.RelativePath.StartsWith("api/applications/", StringComparison.Ordinal) &&
            request.HttpMethod is "PUT" or "DELETE")
        {
            operation.Parameters.Add(new OpenApiParameter
            {
                Name = "If-Match",
                In = ParameterLocation.Header,
                Required = true,
                Description = "The current application ETag, including its quotation marks.",
                Schema = new OpenApiSchema { Type = JsonSchemaType.String }
            });
        }
    }
}
