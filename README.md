# codex2image-gen

[中文说明](./README.zh-CN.md)

Single-file Node.js proxy that exposes an OpenAI-compatible image API on top of a locally logged-in Codex CLI.

![Log viewer](./docs/image.png)

The image endpoint implements:

```text
POST /v1/images/generations
POST /v1/images/edits
```

and uses Codex built-in `$imagegen` under the hood.

`/v1/images/edits` now supports up to 16 input images via JSON fields such as:

- `images: ["/abs/path/a.png", "/abs/path/b.png"]`
- `image: "data:image/png;base64,..."`
- `input_images: [{ "image_url": "https://..." }, { "path": "/abs/path/ref.webp" }]`

## Files

- `codex-openai-proxy.mjs`: proxy server.
- `logs-viewer.html`: log viewer (English / 中文, auto-detected from browser language).
- `docs/codex-openai-proxy.md`: full setup and usage guide.
- `logs/`: daily `jsonl` logs and archived input/output images.

## Quick Start

```bash
node codex-openai-proxy.mjs
```

Then open:

```text
http://localhost:4100/docs    # API overview + screenshots (browser)
http://localhost:4100/logs   # log viewer
http://localhost:4101/       # log viewer (extra port)
```

Read the full documentation:

- Browser: [http://localhost:4100/docs](http://localhost:4100/docs)
- API reference (EN): [docs/codex-openai-proxy.md](./docs/codex-openai-proxy.md)
- API reference (中文): [docs/API.zh-CN.md](./docs/API.zh-CN.md)

## Logging

- Daily logs are written to `logs/YYYY-MM-DD.jsonl`
- Reference images and generated images are archived under `logs/assets/YYYY-MM-DD/<request-id>/`
- `GET /api/logs` returns recent records
- `GET /` and `GET /logs` open the built-in log viewer

## Security

**No HTTP API key is required by default** for local use.

To expose the proxy beyond localhost, copy `.env.example` to `.env` and set `PROXY_API_KEY` to a strong random token, then restart.

Do not commit real tokens, public server IPs, logs, `.env` files, or Codex local data.
