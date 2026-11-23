<p align="center"><img src="./job-application-tracker-logo.png" width="128" alt="AI Job Application Tracker logo"></p>

# AI Job Application Tracker

Import postings, track applications and interviews, and plan follow-ups. The React frontend uses an ASP.NET Core REST API backed by SQLite.

## Run locally

Install Node.js and the .NET 10 SDK. Start the API from the repository root in one PowerShell window:

~~~powershell
dotnet run --project server
~~~

In a second window, start the frontend:

~~~powershell
npm ci
npm run dev
~~~

Open the address printed by Vite, usually http://localhost:5173. Vite proxies API requests to http://127.0.0.1:5080. To try the production frontend build, keep the API running and use npm run build followed by npm run preview.

The API saves applications in server/data/applications.db by default. Set TRACKER_DB_PATH before starting the API to use another file. If you have applications from the previous version, open the app at the same address in the same browser profile. It imports each saved record once and keeps the original browser copy.

## REST API

The [API address](http://127.0.0.1:5080/) opens Swagger UI. You can also download the [OpenAPI document](http://127.0.0.1:5080/swagger/v1/swagger.json). The [HTTP samples](server/Tracker.Api.http) cover every route. Open the file in Visual Studio's HTTP editor or VS Code with REST Client and run the application requests in order so the update and delete requests can reuse the returned ETags.

| Method and path | Purpose |
| --- | --- |
| GET /api/applications | List saved applications |
| POST /api/applications | Create an application |
| GET /api/applications/{id} | Read an application |
| PUT /api/applications/{id} | Replace an application |
| DELETE /api/applications/{id} | Delete an application |
| POST /api/posting-imports | Extract details from a public posting URL |
| GET /api/ai | Check whether an Ollama model is configured |
| POST /api/ai/completions | Request a local model completion |

Send JSON with POST and PUT requests. Send X-Tracker-Request: 1 with each write request. Application responses include an etag value. Send that value in the If-Match header for updates and deletes. The API returns 412 when the record has changed since you read it.

## Optional local AI

Install and start [Ollama](https://ollama.com/), then download a model. In the PowerShell window where you start the API, set the model name:

~~~powershell
$env:OLLAMA_MODEL = "<installed-model-name>"
dotnet run --project server
~~~

Ollama handles free-form text extraction and natural-language search. Recognized pasted formats, structured public posting links, and keyword and due-date matching also work without a model.

## Features

- Filter applications by year, date, and status. Open a day in the calendar to see its positions.
- Complete or snooze reminders, or export them to a calendar.
- Preview postings, share them where the browser supports it, and export HTML or PDF.
- Keep notes and history, and delete postings with confirmation.
