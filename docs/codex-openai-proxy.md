# codex2image-gen

This project includes a single-file Node.js proxy that exposes a small OpenAI-compatible API on top of a locally logged-in Codex CLI.

It is intended for personal/local automation, browser testing, and controlled private deployments. It is not an official OpenAI API server.

## Screenshots

| English | 中文 |
|---------|------|
| ![Log viewer](./image.png) | ![日志查看器](./image-cn.png) |

When the proxy is running, open **http://127.0.0.1:4100/docs** in a browser for a live API summary page (localhost only, no token).

**Detailed API docs:**

- English (this file + sections below)
- 中文：[API.zh-CN.md](./API.zh-CN.md)

## Files

- `codex-openai-proxy.mjs`: Node.js HTTP proxy server.
- `logs-viewer.html`: browser log viewer served at `/` and `/logs`.
- `docs/index.html`: documentation hub served at `/docs`.
- `logs/`: daily `jsonl` audit logs and archived images.

## Features

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `GET /api/logs`
- `GET /logs-assets/...`
- Browser log viewer at `GET /` and `GET /logs`
- Documentation hub at `GET /docs`
- Codex built-in `$imagegen` backend for image generation.
- No Python image CLI and no `OPENAI_API_KEY` requirement for the image endpoint.
- Windows support via shell-based `codex` spawning.
- CORS support for local browser testing.

## Security

**By default, no HTTP API key is required.** The proxy is ready for local use after start.

Before exposing the proxy outside localhost, create `.env` from `.env.example`:

```env
PROXY_API_KEY=your-strong-random-token
```

Restart the proxy after changing `.env`. Do not commit real tokens, public IP addresses, access tokens, logs, or `.env` files.

The proxy shells out to the local `codex` CLI. Treat it as a privileged local service, especially when it is reachable from another machine.

## Prerequisites

1. Node.js 20+.
2. Codex CLI installed and logged in.
3. Confirm `codex` works in the target shell:

```bash
codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly OK"
```

On Windows, confirm this works from `cmd` or PowerShell:

```powershell
codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly OK"
```

## Start

```bash
npm run codex-proxy
```

Or:

```bash
node codex-openai-proxy.mjs
```

Default local URLs:

- `http://localhost:4100/docs` — API overview (browser)
- `http://localhost:4100/logs` — log viewer
- `http://localhost:4100/health`
- `http://localhost:4100/v1/models`
- `http://localhost:4101/` — same log viewer on extra port

The built-in log viewer auto-detects same-origin deployments. If you open it from the proxy itself, it uses the page origin as the Base URL.

## Run In Background On Linux

```bash
setsid -f bash -c 'cd /path/to/project && exec node codex-openai-proxy.mjs >> codex-openai-proxy.log 2>&1 < /dev/null'
```

Check process and ports:

```bash
ps -ef | grep '[c]odex-openai-proxy'
ss -ltnp | grep -E ':(4100|4101)'
```

If you expose the ports publicly, also allow them in the host firewall and cloud security group:

```bash
sudo ufw allow 4100/tcp
sudo ufw allow 4101/tcp
```

## API Authentication

**No HTTP API key is required by default.**

To enable auth, set `PROXY_API_KEY` in `.env` and restart. Then use:

```http
Authorization: Bearer your-strong-random-token
```

The proxy also accepts:

- Header: `X-API-Key: ...`
- Query: `?api_key=...` or `?key=...` (avoid in production; may appear in logs)

### Localhost-only (no token when `PROXY_API_KEY` is set)

From `127.0.0.1` / `::1` only:

- `GET /health` — health JSON
- `GET /`, `GET /logs` — log viewer HTML
- `GET /docs`, `GET /docs/*` — documentation static files
- `GET /api/logs`, `GET /api/logs/days` — log viewer JSON
- `GET /logs-assets/*` — archived log images

### Error format

```json
{
  "error": {
    "message": "Invalid or missing API key.",
    "type": "invalid_api_key",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

## API reference (summary)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | no* | Service health + paths |
| GET | `/v1/models` | no* | Model list |
| POST | `/v1/images/generations` | no* | Text-to-image (`$imagegen`) |
| POST | `/v1/images/edits` | no* | Image edit / up to 16 reference images |
| POST | `/v1/chat/completions` | no* | Chat via Codex CLI |
| POST | `/v1/responses` | no* | Responses API shape |
| GET | `/api/logs/days` | localhost* | Per-day stats |
| GET | `/api/logs` | localhost* | Log records (`day`, `limit`) |

\* Default: no token. With `PROXY_API_KEY` in `.env`, API routes require Bearer; log paths stay localhost-only without token.

See [API.zh-CN.md](./API.zh-CN.md) for full parameter tables and examples in Chinese.

## Image Generation

Request:

```bash
curl http://localhost:4100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-imagegen",
    "prompt": "A simple blue square icon, no text",
    "n": 1,
    "response_format": "b64_json"
  }'
```

Response format:

```json
{
  "created": 1776910000,
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "revised_prompt": null
    }
  ]
}
```

The image endpoint uses:

```text
codex exec "$imagegen ..."
```

It reads image output from Codex session logs first, then falls back to the generated image files under:

```text
$CODEX_HOME/generated_images
```

If `CODEX_HOME` is not set, the default is:

```text
~/.codex/generated_images
```

## Image Edits With Multiple Input Images

The proxy now supports JSON-based multi-image input for `POST /v1/images/edits`.

- Maximum input images: `16`
- Supported input forms:
  - absolute local file paths
  - `http://` / `https://` image URLs
  - `data:image/...;base64,...`
  - raw base64 image strings
  - objects like `{ "image_url": "https://..." }` or `{ "path": "/abs/path/ref.png" }`

Example:

```bash
curl http://localhost:4100/v1/images/edits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-imagegen",
    "prompt": "Create a polished composite using the references.",
    "images": [
      "/absolute/path/ref-1.png",
      "/absolute/path/ref-2.png"
    ],
    "n": 1,
    "response_format": "b64_json"
  }'
```

Internally the proxy materializes remote/data-URL inputs into temporary image files and calls:

```text
codex exec --image <file1> --image <file2> -
```

The prompt is sent via stdin to avoid CLI argument parsing issues with `--image`.

## Chat Completions

```bash
curl http://localhost:4100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-cli",
    "messages": [
      { "role": "user", "content": "Reply with a one-line status." }
    ]
  }'
```

## Responses API

```bash
curl http://localhost:4100/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-cli",
    "input": "Explain this project briefly."
  }'
```

## Logs

Each image request writes one JSONL record per day:

```text
logs/YYYY-MM-DD.jsonl
```

Each record includes:

- request time
- prompt
- whether generation succeeded
- error message when failed
- archived reference image paths
- archived generated image paths

Archived image files are stored here:

```text
logs/assets/YYYY-MM-DD/<request-id>/
```

API and UI:

- `GET /api/logs?limit=100`
- `GET /api/logs?day=YYYY-MM-DD`
- `GET /`
- `GET /logs`

## Browser Viewer

Open:

```text
http://localhost:4101/
```

If hosted on a remote server, open the server URL in the browser and enter the private token in the API key field.

## Troubleshooting

Check health:

```bash
curl http://localhost:4100/health \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN"
```

Check CORS preflight:

```bash
curl -i -X OPTIONS http://localhost:4100/v1/images/generations \
  -H "Origin: http://localhost:8080" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

If the process is listening but requests hang, restart the proxy and inspect `codex-openai-proxy.log`.

If image generation completes but no image is returned, check:

```bash
find ~/.codex/generated_images -type f
find ~/.codex/sessions -type f -name '*.jsonl'
```

On Windows, check:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
Get-ChildItem "$codexHome\generated_images" -Recurse
Get-ChildItem "$codexHome\sessions" -Recurse -Filter *.jsonl
```
