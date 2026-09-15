# Dola OpenAI and Claude Code Proxy

A local HTTP proxy that exposes the signed-in Dola Desktop app through OpenAI-compatible APIs and the Anthropic Messages API used by Claude Code.

The proxy connects to Dola through the Chrome DevTools Protocol (CDP), opens a fresh chat, selects the requested Dola mode, attaches files, submits the prompt, and streams Dola's response back to the client. Dola continues to manage its own cookies, `msToken`, and anti-bot signatures; this project does not extract or store Dola login credentials.

> [!IMPORTANT]
> This is an unofficial project and is not affiliated with Dola/Cici or OpenAI. Use it only with your own account and device, and follow the applicable terms of service.

## Features

- OpenAI-compatible `POST /v1/chat/completions` endpoint.
- Anthropic-compatible `POST /v1/messages` endpoint for Claude Code, including client tool calls and SSE streaming.
- Anthropic-compatible `POST /v1/messages/count_tokens` estimate for Claude Code context budgeting.
- OpenAI-style `POST /v1/images/generations` endpoint with URL or base64 output.
- Asynchronous video jobs through `POST /v1/videos`, polling, and content download.
- Regular JSON and Server-Sent Events (SSE) streaming responses.
- Dola Fast, Pro, Create Image, and Create Video selection through API model IDs.
- Image and document attachments using Dola's native upload control.
- OpenAI `image_url` content parts, data URLs, base64 data, and remote URLs.
- Custom `file`, `input_file`, and top-level `attachments` inputs for documents.
- Optional Bearer or `x-api-key` authentication.
- Direct Node.js and Docker Compose deployment.
- Request serialization because Dola has one active chat UI at a time.
- Expiring local media URLs that hide Dola's signed CDN URLs and support HTTP Range requests.

## How it works

```text
OpenAI client / 9Router / Claude Code
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
| Model | `dola`, `dola-fast`, `dola-pro`, `dola-image`, or `dola-video` | Same |

Replace `8317` when `DOLA_PROXY_PORT` uses a different port. If the UI asks for a complete endpoint instead of a base URL, use:

```text
http://127.0.0.1:8317/v1/chat/completions
```

9Router uses Chat Completions. `dola-image` therefore returns generated images as Markdown plus structured `message.media` metadata. Use the dedicated Videos API described below when a client needs to create and poll `dola-video` jobs.

## Claude Code configuration

Claude Code must use the proxy root URL (without `/v1`). In PowerShell, configure the current terminal and then start Claude Code:

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8317'
$env:ANTHROPIC_AUTH_TOKEN = 'your-api-key'
$env:ANTHROPIC_MODEL = 'dola-pro'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'dola-pro'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'dola-pro'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'dola-fast'
claude
```

The same values can be placed in Claude Code's `settings.json`:

```json
{
  "model": "dola-pro",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "dola-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "dola-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "dola-fast"
  }
}
```

Claude Code sends its tools in the Anthropic `tools` field. The proxy teaches Dola a private tool-call envelope, converts valid calls into `tool_use` content blocks, and accepts Claude Code's `tool_result` blocks on the next request. Tool execution and permission prompts remain inside Claude Code.

## Models

`GET /v1/models` returns:

| API model | Dola mode | Notes |
|---|---|---|
| `dola` | Fast | Default alias. |
| `dola-fast` | Fast | Dola's general-purpose mode. |
| `dola-pro` | Pro | Dola's advanced Pro mode. Availability can depend on the signed-in Dola account. |
| `dola-image` | Create Image | Generates images. Use it with Chat Completions or the Images endpoint. |
| `dola-video` | Create Video | Starts asynchronous video generation. The Videos endpoint is recommended. |

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

### Generated media in Chat Completions

`dola-image` can be used through Chat Completions when a client only supports that API:

```json
{
  "model": "dola-image",
  "messages": [
    { "role": "user", "content": "A watercolor lighthouse at sunrise" }
  ]
}
```

The assistant content includes a Markdown media link. The response also includes a Dola Proxy extension at `choices[0].message.media`:

```json
{
  "role": "assistant",
  "content": "![Generated image 1](http://127.0.0.1:8317/v1/media/media_...)",
  "media": [
    {
      "id": "media_...",
      "type": "image",
      "url": "http://127.0.0.1:8317/v1/media/media_...",
      "mime_type": "image/png",
      "width": 2048,
      "height": 2048
    }
  ]
}
```

Streaming Chat Completions emit the same `media` array in a final delta before `finish_reason: "stop"`.

### Image generations

This endpoint follows the URL/base64 conventions of the [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation).

```http
POST /v1/images/generations
Authorization: Bearer <DOLA_PROXY_API_KEY>
Content-Type: application/json
```

URL response:

```json
{
  "model": "dola-image",
  "prompt": "A minimal teal circle on a white background, no text",
  "n": 1,
  "response_format": "url"
}
```

`n` accepts `1` through `4`. Dola normally creates multiple candidates; the proxy returns up to the requested number. Set `response_format` to `b64_json` to receive inline base64 instead of an expiring URL.

### Video generations

Video creation is asynchronous, matching the job, polling, and content-download pattern in the [OpenAI video generation guide](https://developers.openai.com/api/docs/guides/video-generation):

```http
POST /v1/videos
Authorization: Bearer <DOLA_PROXY_API_KEY>
Content-Type: application/json
```

```json
{
  "model": "dola-video",
  "prompt": "A calm ocean wave reaching an empty beach at sunrise"
}
```

The initial response contains a job ID and normally has `status: "in_progress"`:

```json
{
  "id": "video_...",
  "object": "video",
  "status": "in_progress",
  "model": "dola-video",
  "progress": 0
}
```

Poll the job until it is `completed` or `failed`:

```http
GET /v1/videos/video_...
Authorization: Bearer <DOLA_PROXY_API_KEY>
```

Download a completed video. This endpoint supports `GET`, `HEAD`, and `Range` requests:

```http
GET /v1/videos/video_.../content
Authorization: Bearer <DOLA_PROXY_API_KEY>
```

Dola usually takes one to three minutes to render a video. A rejected prompt becomes a `failed` job with Dola's moderation message in `error.message`.

### Media URLs

Generated URL responses point to `/v1/media/media_...`, not to Dola's signed CDN. These opaque URLs expire after `DOLA_MEDIA_TTL_MS` and proxy the original MIME type, content length, and byte ranges. They intentionally work without an Authorization header so browsers, Markdown renderers, and HTML media elements can load them. Keep the proxy bound to localhost and treat each media URL as a temporary capability token.

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
| `DOLA_MEDIA_TTL_MS` | `3600000` | Lifetime of generated media URLs in milliseconds. |
| `DOLA_MAX_MEDIA_BYTES` | `52428800` | Maximum generated file size that can be buffered for `b64_json`. URL streaming is not buffered. |

## Compatibility and limitations

Supported:

- Text message content.
- Dola Fast and Pro modes.
- Dola image generation with URL and base64 output.
- Dola asynchronous video jobs, polling, failure reporting, and ranged downloads.
- Non-streaming and SSE streaming responses.
- Images and Dola-supported document types.
- `stream_options.include_usage`, with zero-valued usage fields for client compatibility.
- Anthropic Messages JSON/SSE responses, `system` blocks, `tool_use`, and `tool_result` for Claude Code.

Not mapped to the OpenAI Chat Completions endpoint:

- Tool or function calling.
- Audio input/output.
- `logprobs`.
- Sampling controls such as `temperature`, `top_p`, and `seed`.
- Real token usage statistics.

Anthropic token counts are estimates because Dola does not expose tokenizer or usage data. Tool calls are prompt-driven rather than grammar-constrained, so malformed tool markup is returned as ordinary text instead of being executed. Dola's single desktop chat still serializes Claude Code requests, including subagent requests.

The full OpenAI message history is converted to a labeled transcript and submitted in a fresh Dola chat. Attachments found anywhere in that history are uploaded to the fresh chat. Requests are processed one at a time.

Video jobs and media metadata are kept in memory. Restarting the proxy invalidates existing job IDs and media URLs. Dola may enforce account quotas, model availability, and prompt moderation independently of this proxy.

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

The test suite covers attachments, model routing, SSE text and creation blocks, media deduplication and limits, authentication, URL/base64 images, regular and streaming Chat Completions media, asynchronous video completion and failure, HTTP Range, and content download.

## Security

- Docker publishes the API only on `127.0.0.1` by default.
- Never commit `.env` or a real API key.
- Use a strong API key whenever another process can access the proxy.
- Do not expose DevTools port `9229` or this proxy directly to the Internet.
- Remote attachment URLs are downloaded by the proxy; only send URLs you trust.
- Any client that can call this API can use the signed-in Dola session.
- Generated `/v1/media/...` URLs do not require the Bearer key; they are random, temporary capability URLs.

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
|   |-- media-store.js
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
