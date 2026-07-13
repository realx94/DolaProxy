# Dola OpenAI Proxy

A local HTTP proxy that exposes the signed-in Dola Desktop app through an OpenAI-compatible Chat Completions API.

The proxy connects to Dola through the Chrome DevTools Protocol (CDP), opens a fresh chat, selects the requested Dola mode, attaches files, submits the prompt, and streams Dola's response back to the client. Dola continues to manage its own cookies, `msToken`, and anti-bot signatures; this project does not extract or store Dola login credentials.

> [!IMPORTANT]
> This is an unofficial project and is not affiliated with Dola/Cici or OpenAI. Use it only with your own account and device, and follow the applicable terms of service.

## Features

- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Regular JSON and Server-Sent Events (SSE) streaming responses.
- Dola Fast and Pro mode selection through API model IDs.
- Image and document attachments using Dola's native upload control.
- OpenAI `image_url` content parts, data URLs, base64 data, and remote URLs.
- Custom `file`, `input_file`, and top-level `attachments` inputs for documents.
- Optional Bearer API-key authentication.
- Direct Node.js and Docker Compose deployment.
- Request serialization because Dola has one active chat UI at a time.

## How it works

```text
OpenAI client / 9Router
          |
          | HTTP /v1/chat/completions
          v
  Dola OpenAI Proxy
          |
          | Chrome DevTools Protocol
          v
 Dola Desktop (signed in)
          |
          v
      Dola service
```

Dola Desktop always runs on the Windows host. When the proxy runs in Docker, the container connects back to Dola DevTools through `host.docker.internal`.

## Requirements

- Windows 10 or Windows 11.
- Dola Desktop installed and signed in.
- Node.js 22 or newer.
- Docker Desktop when using Docker Compose.

The launcher script looks for Dola at:

```text
%LOCALAPPDATA%\Cici\Application\app\Cici.exe
```

## Installation

Clone the repository and create the local environment file:

```powershell
git clone https://github.com/realx94/DolaProxy.git
Set-Location DolaProxy
Copy-Item .env.example .env
```

Change the default API key in `.env`:

```dotenv
DOLA_PROXY_API_KEY=replace-with-a-long-random-api-key
```

Do not commit `.env`. It is already excluded by `.gitignore`.

## Run with Docker Compose

Start Dola with DevTools enabled, then build and start the proxy:

```powershell
npm run dola
npm run docker:up
docker compose ps
```

The default Docker base URL is:

```text
http://127.0.0.1:8317/v1
```

Management commands:

```powershell
npm run docker:logs
npm run docker:down
```

The container always listens on port `3000`. `DOLA_PROXY_PORT` controls only the port published on the Windows host.

## Run directly with Node.js

The proxy has no external npm dependencies, so `npm install` is not required:

```powershell
npm run dola
npm start
```

The default direct-run base URL is:

```text
http://127.0.0.1:3000/v1
```

Change `PORT` in `.env`, or override it for the current PowerShell session:

```powershell
$env:PORT = '8317'
npm start
```

## 9Router configuration

Select an **OpenAI Compatible** provider and enter:

| Field | 9Router on Windows host | 9Router in Docker |
|---|---|---|
| API Host / Base URL | `http://127.0.0.1:8317/v1` | `http://host.docker.internal:8317/v1` |
| API Key | The `DOLA_PROXY_API_KEY` value from `.env` | The `DOLA_PROXY_API_KEY` value from `.env` |
| Model | `dola`, `dola-fast`, or `dola-pro` | `dola`, `dola-fast`, or `dola-pro` |

Replace `8317` when `DOLA_PROXY_PORT` uses a different port. If the UI asks for a complete endpoint instead of a base URL, use:

```text
http://127.0.0.1:8317/v1/chat/completions
```

## Models

`GET /v1/models` returns:

| API model | Dola mode | Notes |
|---|---|---|
| `dola` | Fast | Default alias. |
| `dola-fast` | Fast | Dola's general-purpose mode. |
| `dola-pro` | Pro | Dola's advanced Pro mode. Availability can depend on the signed-in Dola account. |

Unknown model IDs return an OpenAI-style `400 model_not_found` error.

## API endpoints

### Health

```http
GET /health
```

The health endpoint does not require an API key. Example response:

```json
{
  "status": "ok",
  "dola": {
    "connected": true,
    "page": "dola://dola-chat/chat/..."
  }
}
```

### Models

```http
GET /v1/models
Authorization: Bearer <DOLA_PROXY_API_KEY>
```

### Chat Completions

```http
POST /v1/chat/completions
Authorization: Bearer <DOLA_PROXY_API_KEY>
Content-Type: application/json
```

Minimal request:

```json
{
  "model": "dola-fast",
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

Streaming request:

```json
{
  "model": "dola-pro",
  "stream": true,
  "stream_options": { "include_usage": true },
  "messages": [
    { "role": "user", "content": "Write a short greeting" }
  ]
}
```

## File attachments

Dola currently accepts these extensions:

```text
.pdf .txt .csv .docx .doc .xlsx .xls .pptx .ppt .md
.mobi .epub .png .jpeg .jpg .webp
```

The default limit is 20 MiB per file and 32 MiB for the complete JSON request. Both limits are configurable.

### OpenAI image content part

The proxy supports the standard Chat Completions `image_url` shape documented in the [OpenAI Chat Completions API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):

```json
{
  "model": "dola-pro",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAA..."
          }
        }
      ]
    }
  ]
}
```

An `http://` or `https://` image URL can be used instead of a data URL. The proxy downloads it before attaching it to Dola.

### Document content part

General document upload is a Dola Proxy extension to Chat Completions. Use a `file` content part:

```json
{
  "model": "dola-pro",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Summarize this document" },
        {
          "type": "file",
          "file": {
            "filename": "report.pdf",
            "file_data": "data:application/pdf;base64,JVBERi0xLjQ..."
          }
        }
      ]
    }
  ]
}
```

The proxy also accepts an `input_file` content part:

```json
{
  "type": "input_file",
  "filename": "notes.txt",
  "file_data": "data:text/plain;base64,SGVsbG8="
}
```

Local OpenAI `file_id` values cannot be resolved because this proxy does not host the OpenAI Files API. Send `file_data` or a URL instead.

### Top-level attachments extension

Clients that cannot create multimodal message parts can use `attachments`:

```json
{
  "model": "dola-fast",
  "messages": [
    { "role": "user", "content": "Summarize the attached file" }
  ],
  "attachments": [
    {
      "filename": "notes.txt",
      "mime_type": "text/plain",
      "data": "SGVsbG8gZnJvbSB0aGUgZmlsZQ=="
    }
  ]
}
```

Each item accepts:

- `filename` or `name`.
- `file_data` or `data`, containing raw base64 or a data URL.
- `url`, containing an `http://` or `https://` URL, instead of inline data.
- `mime_type`, `content_type`, or `type` when the source does not provide a MIME type.

## Client examples

### PowerShell

```powershell
$headers = @{
    Authorization = 'Bearer your-api-key'
    'Content-Type' = 'application/json'
}

$body = @{
    model = 'dola-pro'
    messages = @(
        @{ role = 'user'; content = 'Hello from PowerShell' }
    )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod 'http://127.0.0.1:8317/v1/chat/completions' `
    -Method Post `
    -Headers $headers `
    -Body $body
```

### OpenAI JavaScript SDK

```js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "your-api-key",
  baseURL: "http://127.0.0.1:8317/v1",
});

const stream = await openai.chat.completions.create({
  model: "dola-fast",
  stream: true,
  messages: [{ role: "user", content: "Write a short greeting" }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### cURL

```powershell
curl.exe http://127.0.0.1:8317/v1/chat/completions `
  -H "Authorization: Bearer your-api-key" `
  -H "Content-Type: application/json" `
  -d '{"model":"dola-fast","messages":[{"role":"user","content":"Hello"}]}'
```

## Environment variables

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `127.0.0.1` | Bind address when running directly. |
| `PORT` | `3000` | Direct-run port and internal container port. |
| `DOLA_PROXY_PORT` | `8317` | Port published by Docker on the Windows host. |
| `DOLA_PROXY_API_KEY` | `change-me` | Bearer key. An empty value disables authentication. |
| `DOLA_DEBUG_URL` | `http://127.0.0.1:9229` | Dola DevTools endpoint for direct runs. |
| `DOLA_DEBUG_PORT` | `9229` | DevTools port opened by the launcher and used by Docker. |
| `DOLA_REQUEST_TIMEOUT_MS` | `360000` | Maximum Dola response time in milliseconds. |
| `DOLA_MAX_REQUEST_BYTES` | `33554432` | Maximum JSON request size, including base64 data. |
| `DOLA_MAX_FILE_BYTES` | `20971520` | Maximum decoded size of one attachment. |

## Compatibility and limitations

Supported:

- Text message content.
- Dola Fast and Pro modes.
- Non-streaming and SSE streaming responses.
- Images and Dola-supported document types.
- `stream_options.include_usage`, with zero-valued usage fields for client compatibility.

Not mapped to Dola:

- Tool or function calling.
- Audio input/output.
- `logprobs`.
- Sampling controls such as `temperature`, `top_p`, and `seed`.
- Real token usage statistics.

The full OpenAI message history is converted to a labeled transcript and submitted in a fresh Dola chat. Attachments found anywhere in that history are uploaded to the fresh chat. Requests are processed one at a time.

## Troubleshooting

### `Cannot reach Dola DevTools`

Restart Dola with DevTools enabled:

```powershell
npm run dola
```

### `Dola chat page was not found`

Make sure Dola is signed in and its chat UI has finished loading. Then check:

```powershell
Invoke-RestMethod http://127.0.0.1:9229/json/list
```

### `401 Invalid API key`

The client key must exactly match `DOLA_PROXY_API_KEY` in `.env`. Recreate the container after changing `.env`:

```powershell
npm run docker:up
```

### Docker cannot connect to Dola

Check DevTools on the host and inspect container logs:

```powershell
Invoke-RestMethod http://127.0.0.1:9229/json/version
npm run docker:logs
```

### Attachment is rejected

Confirm the filename has one of Dola's supported extensions, the base64 is valid, and the decoded file is within `DOLA_MAX_FILE_BYTES`. Remote downloads must return a successful HTTP response.

### Requests run sequentially

This is intentional. Dola exposes one active chat interface, so the proxy queues requests to prevent mixed prompts and responses.

## Testing

```powershell
npm test
```

The unit tests use Node.js's built-in test runner and do not require a live Dola session.

## Security

- Docker publishes the API only on `127.0.0.1` by default.
- Never commit `.env` or a real API key.
- Use a strong API key whenever another process can access the proxy.
- Do not expose DevTools port `9229` or this proxy directly to the Internet.
- Remote attachment URLs are downloaded by the proxy; only send URLs you trust.
- Any client that can call this API can use the signed-in Dola session.

## Project structure

```text
.
|-- compose.yaml
|-- Dockerfile
|-- package.json
|-- scripts/
|   `-- start-dola.ps1
|-- src/
|   |-- attachments.js
|   |-- cdp.js
|   |-- config.js
|   |-- dola-client.js
|   |-- dola-sse.js
|   |-- models.js
|   |-- openai.js
|   |-- prompt.js
|   `-- server.js
`-- test/
    |-- attachments.test.js
    |-- dola-sse.test.js
    |-- models.test.js
    |-- prompt.test.js
```

## License

No open-source license has been added yet. Copyright remains with the repository owner by default.
