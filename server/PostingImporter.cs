using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using HtmlAgilityPack;

sealed class PostingException(string message) : Exception(message);

sealed class PostingImporter(HttpClient client)
{
    private const int DownloadLimit = 2_000_000;
    private const int DescriptionLimit = 45_000;

    public static SocketsHttpHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        ConnectCallback = async (context, cancel) =>
        {
            var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, AddressFamily.InterNetwork, cancel);
            var address = Array.Find(addresses, IsPublic);
            if (address is null) throw new PostingException("Use a public posting URL.");

            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            try
            {
                await socket.ConnectAsync(address, context.DnsEndPoint.Port, cancel);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }
    };

    private static bool IsPublic(IPAddress address) => address.GetAddressBytes() switch
    {
        [0 or 10 or 127 or >= 224, ..] => false,
        [100, >= 64 and <= 127, ..] => false,
        [169, 254, ..] => false,
        [172, >= 16 and <= 31, ..] => false,
        [192, 0, 0 or 2, _] => false,
        [192, 88, 99, _] => false,
        [192, 168, ..] => false,
        [198, 18 or 19, ..] => false,
        [198, 51, 100, _] => false,
        [203, 0, 113, _] => false,
        _ => true
    };

    public async Task<object> Import(string? input, CancellationToken cancel)
    {
        if (input is null || input.Length > 2000 || !Uri.TryCreate(input, UriKind.Absolute, out var url))
            throw new PostingException("Enter a valid HTTP or HTTPS posting URL.");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        for (var redirects = 0; redirects <= 4; redirects++)
        {
            if (url.Scheme is not ("http" or "https") || url.UserInfo.Length != 0 || !url.IsDefaultPort ||
                url.HostNameType is not (UriHostNameType.Dns or UriHostNameType.IPv4) ||
                IPAddress.TryParse(url.Host, out var ip) && !IsPublic(ip))
                throw new PostingException("Use a public HTTP or HTTPS posting URL.");

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Accept.ParseAdd("text/html");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308 &&
                response.Headers.Location is { } location && Uri.TryCreate(url, location, out var next))
            {
                url = next;
                continue;
            }
            if (response.StatusCode != HttpStatusCode.OK ||
                !string.Equals(response.Content.Headers.ContentType?.MediaType, "text/html", StringComparison.OrdinalIgnoreCase))
                break;
            if (response.Content.Headers.ContentLength > DownloadLimit)
                throw new PostingException("The posting is too large to import.");

            await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var data = new MemoryStream();
            var buffer = new byte[8192];
            int size;
            while ((size = await body.ReadAsync(buffer, timeout.Token)) != 0)
            {
                if (data.Length + size > DownloadLimit) throw new PostingException("The posting is too large to import.");
                data.Write(buffer, 0, size);
            }
            return ParsePage(Encoding.UTF8.GetString(data.GetBuffer(), 0, (int)data.Length), url.Host);
        }
        throw new PostingException("The link did not return a public job posting.");
    }

    private static object ParsePage(string html, string host)
    {
        var page = new HtmlDocument();
        page.LoadHtml(html);
        foreach (var block in page.DocumentNode.SelectNodes("//script[@type='application/ld+json']") ?? Enumerable.Empty<HtmlNode>())
        {
            try
            {
                using var json = JsonDocument.Parse(block.InnerHtml);
                if (FindPosting(json.RootElement) is { } job) return ReadPosting(job);
            }
            catch (JsonException)
            {
                // Other JSON-LD blocks may contain the posting.
            }
        }

        if (host == "careers.n-ix.com" && ReadNixPosting(page.DocumentNode) is { } posting) return posting;
        throw new PostingException("This page has no readable job details for local import. Paste the posting text to continue.");
    }

    private static JsonElement? FindPosting(JsonElement value)
    {
        if (Items(Property(value, "@type")).Any(type => String(type) == "JobPosting")) return value;
        IEnumerable<JsonElement> children = value.ValueKind switch
        {
            JsonValueKind.Object => value.EnumerateObject().Select(property => property.Value),
            JsonValueKind.Array => value.EnumerateArray(),
            _ => []
        };
        foreach (var child in children)
            if (FindPosting(child) is { } job) return job;
        return null;
    }

    private static object ReadPosting(JsonElement job)
    {
        var places = Items(Property(job, "jobLocation")).Select(place =>
        {
            var address = Property(place, "address");
            return Join(", ", new[] { "addressLocality", "addressRegion", "addressCountry" }
                .Select(key => Property(address, key)).Select(value => String(value) ?? String(Property(value, "name"))));
        });
        var salary = Property(job, "baseSalary");
        var value = Property(salary, "value");
        var amount = Scalar(value) ?? Scalar(Property(value, "value")) ??
            Join(" - ", new[] { Scalar(Property(value, "minValue")), Scalar(Property(value, "maxValue")) });
        var deadline = String(Property(job, "validThrough")) ?? "";
        return new
        {
            fields = new
            {
                role = Plain(String(Property(job, "title"))),
                company = String(Property(Property(job, "hiringOrganization"), "name")),
                location = Join(" / ", places),
                arrangement = String(Property(job, "jobLocationType")) == "TELECOMMUTE" ? "Remote" : "",
                salary = amount.Length == 0 ? "" : Join(" ", new[]
                    { String(Property(salary, "currency")), amount, String(Property(value, "unitText")) }),
                deadline = deadline[..Math.Min(10, deadline.Length)],
                requirements = Plain(String(Property(job, "qualifications")))
            },
            text = TrimDescription(Plain(String(Property(job, "description"))))
        };
    }

    private static object? ReadNixPosting(HtmlNode page)
    {
        var posting = page.SelectSingleNode(WithClass("*", "job-details-new"));
        var description = posting?.SelectSingleNode(WithClass("*", "section-description"));
        var role = Regex.Replace(Text(posting?.SelectSingleNode(WithClass("h1", "job-title"))), @"\s*\(#\d+\)$", "");
        if (role.Length == 0 || description is null || Text(description).Length == 0) return null;

        const string headings = ".//h2 | .//h3 | .//h4 | .//h5 | .//h6";
        var heading = description.SelectNodes(headings)?.FirstOrDefault(node =>
            Text(node).TrimEnd(':').Equals("requirements", StringComparison.OrdinalIgnoreCase));
        var requirements = new List<string>();
        for (var node = heading?.NextSibling; node is not null && node.Name is not ("h2" or "h3" or "h4" or "h5" or "h6"); node = node.NextSibling)
            requirements.AddRange((node.SelectNodes(".//li") ?? Enumerable.Empty<HtmlNode>()).Select(Text));

        var text = Join("\n", (description.SelectNodes(".//p | .//li | " + headings) ?? Enumerable.Empty<HtmlNode>()).Select(Text));
        return new
        {
            fields = new
            {
                role,
                company = "N-iX",
                location = Text(posting?.SelectSingleNode(WithClass("*", "location-info"))),
                arrangement = Text(posting?.SelectSingleNode(WithClass("*", "job-info-office"))),
                requirements = Join("\n", requirements)
            },
            text = TrimDescription(text.Length == 0 ? Text(description) : text)
        };
    }

    private static string WithClass(string tag, string cssClass) =>
        $".//{tag}[contains(concat(' ', normalize-space(@class), ' '), ' {cssClass} ')]";

    private static JsonElement Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var result) ? result : default;
    private static IEnumerable<JsonElement> Items(JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [value];
    private static string? String(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string? Scalar(JsonElement value) => value.ValueKind == JsonValueKind.Number ? value.GetRawText() : String(value);
    private static string Join(string separator, IEnumerable<string?> values) =>
        string.Join(separator, values.Where(value => !string.IsNullOrWhiteSpace(value)));
    private static string Text(HtmlNode? node) => WebUtility.HtmlDecode(node?.InnerText ?? "").Trim();
    private static string TrimDescription(string text) => text[..Math.Min(text.Length, DescriptionLimit)];

    private static string Plain(string? html)
    {
        if (html is null) return "";
        var page = new HtmlDocument();
        page.LoadHtml(Regex.Replace(html, @"</(?:p|li|div|h[1-6])>|<br\s*/?\s*>", "$0\n", RegexOptions.IgnoreCase));
        return Text(page.DocumentNode);
    }
}

