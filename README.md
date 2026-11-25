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

Open **Settings** in the frontend to see the active database path. The default is `server/data/applications.db`. Set `TRACKER_DB_PATH` before starting the API to use another file. If you have applications from the previous version, open the app at the same address in the same browser profile. It imports each saved record once and keeps the original browser copy.

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
| POST /api/application-imports/preview | Preview a CSV or Excel file uploaded as multipart field `file` |
| GET /api/ai | Check whether an Ollama model is configured |
| GET /api/ai/models | List installed Ollama models |
| POST /api/ai/completions | Request a local model completion |
| GET /api/ai/activity | List tracked Ollama calls, newest first |
| GET /api/ai/activity/{id} | Read the full prompts and response for one call |
| GET /api/settings | Read the active database path and Ollama preferences |
| PUT /api/settings/ollama | Set the model, disable AI, or restore the server default |

Send JSON with POST and PUT requests. Send X-Tracker-Request: 1 with each write request. Application responses include an etag value. Send that value in the If-Match header for updates and deletes. The API returns 412 when the record has changed since you read it.

## Optional local AI

Open **Settings** for installation and model download steps. After starting [Ollama](https://ollama.com/) on the API host, check the connection, select an installed model or enter its tag, and save. The choice is saved in SQLite and takes effect immediately. You can also disable AI there.

The **Use server default** option reads `OLLAMA_MODEL` from the API environment. To set that default in PowerShell before starting the API:

~~~powershell
$env:OLLAMA_MODEL = "<installed-model-name>"
dotnet run --project server
~~~

Ollama handles free-form text extraction and natural-language search. Recognized pasted formats, structured public posting links, and keyword and due-date matching also work without a model.

Use **Fill with AI** to scan saved job descriptions for missing posting details. Review the suggested values and choose which applications to update. Existing field values are kept.

Open **Settings → Ollama activity** to review prompt and response history. The tracker stores the full system prompt, user prompt, raw Ollama response, and any error in SQLite. Prompts can include job descriptions and notes. Logging begins after you restart the API with this feature.

## Features

- Filter applications by year, date, and status. Open a day in the calendar to see its positions.
- Use **Select applications** in the main list to delete multiple visible applications at once.
- Complete or snooze reminders, or export them to a calendar.
- Preview postings, share them where the browser supports it, and export HTML or PDF.
- Applications for the same company share a logo stored in the SQLite `companies` table. Paste an image or its URL into the company logo field, upload a file, or import the logo from a supported posting. The list shows the logo when available and the company's initial otherwise.
- Format job descriptions with headings, emphasis, and lists. The application preview and HTML export preserve supported formatting.
- Use the Notes tab to add, edit, and delete timestamped notes. Click **Save application** to keep the changes. SQLite stores each note in the `application_notes` table and links it to its application. Existing notes move to that table automatically when the API starts. Older personal notes without timestamps show unknown dates.
- View application activity and delete postings with confirmation.
- Use **Import spreadsheet** to preview and select rows from a LinkedIn Applications CSV or an Excel `.xlsx` worksheet with the same headings. Application Date accepts the export's month/day/year format or ISO dates and keeps a time when supplied. Each pipe-separated Question And Answers entry becomes a note. Contact details and resume names are shown in the preview only.
- The import checks public posting URLs for additional job details. For a posting that requires sign-in, use **Open in this browser** and **Paste posting text** in the preview. If a posting is unavailable, you can still import its spreadsheet values.

## Read signed-in LinkedIn postings

In the Chrome or Edge profile where you use the tracker, open the browser's Extensions page, enable **Developer mode**, and choose **Load unpacked**. Select the [browser-extension](browser-extension) folder and reload the tracker. The extension supports the default Vite dev and preview addresses on `localhost` or `127.0.0.1`.

Sign in to LinkedIn in that same profile. In the spreadsheet preview, click **Read LinkedIn in background** after the public posting check. The extension opens the selected LinkedIn postings that could not be read publicly, fills in available details, and closes the background tabs. Click **Cancel reading** to stop the batch and keep the details already collected. Review the preview before importing. If LinkedIn has removed a posting or asks you to sign in, the row retains its spreadsheet values.
