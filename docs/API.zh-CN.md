# API 参考（中文）

本地代理地址默认：`http://127.0.0.1:4100`（备用端口 `4101` 行为相同）。

浏览器文档：`http://127.0.0.1:4100/docs`  
日志查看：`http://127.0.0.1:4100/logs`

---

## 鉴权

**默认无需 API Key**，本机启动后可直接调用各接口。

若需在局域网或公网暴露时加固，在项目目录创建 `.env`（可参考 `.env.example`）：

```env
PROXY_API_KEY=your-strong-random-token
```

设置 `PROXY_API_KEY` 后，除下列**本机免鉴权**路径外，请求需携带相同令牌：

```http
Authorization: Bearer your-strong-random-token
```

也支持（不推荐生产环境）：

- 请求头：`X-API-Key: ...`
- 查询参数：`?api_key=...` 或 `?key=...`（会进入访问日志，慎用）

### 本机免鉴权（仅 `127.0.0.1` / `::1`；且仅在已配置 `PROXY_API_KEY` 时生效）

| 路径 | 说明 |
|------|------|
| `GET /health` | 健康检查 JSON |
| `GET /`、`GET /logs` | 日志查看页 HTML |
| `GET /docs`、`GET /docs/*` | 文档与截图静态资源 |
| `GET /api/logs`、`GET /api/logs/days` | 日志查看器数据接口 |
| `GET /logs-assets/*` | 日志归档图片 |

未配置 `PROXY_API_KEY` 时，局域网也可直接访问全部接口。已配置时，从非本机 IP 访问上述路径仍需令牌。

---

## 错误响应

HTTP 4xx/5xx 时返回 OpenAI 风格 JSON：

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

常见 `type`：`invalid_api_key`、`invalid_request_error`、`not_found_error`、`server_error`。

---

## 端点一览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/health` | 否（有 key 时本机免鉴权） | 服务健康与路径信息 |
| GET | `/v1/models` | 是 | 可用模型列表 |
| POST | `/v1/images/generations` | 是 | 文生图（Codex `$imagegen`） |
| POST | `/v1/images/edits` | 是 | 图生图 / 多参考图（最多 16 张） |
| POST | `/v1/chat/completions` | 是 | 对话补全（转发 Codex CLI） |
| POST | `/v1/responses` | 是 | Responses 形态（转发 Codex CLI） |
| GET | `/api/logs/days` | 本机免鉴权 | 按日统计 |
| GET | `/api/logs` | 本机免鉴权 | 按日或最近记录列表 |
| GET | `/`、`/logs` | 否 | 日志 UI |
| GET | `/docs` | 本机免鉴权 | 文档页 |

---

## GET /health

**响应示例：**

```json
{
  "ok": true,
  "service": "codex2image-gen",
  "codexBinary": "/Applications/Codex.app/.../codex",
  "defaultModel": "codex-cli",
  "defaultImageModel": "gpt-image-2",
  "imageModels": ["gpt-image-2", "gpt-image-1", "dall-e-3", "dall-e-2", "codex-imagegen"],
  "imageBackend": "codex-builtin",
  "defaultSandbox": "read-only",
  "defaultCwd": "/path/to/project",
  "codexHome": "/Users/you/.codex",
  "generatedImagesRoot": "/Users/you/.codex/generated_images",
  "sessionsRoot": "/Users/you/.codex/sessions"
}
```

---

## GET /v1/models

**响应示例：**

```json
{
  "object": "list",
  "data": [
    { "id": "codex-cli", "object": "model", ... },
    { "id": "gpt-image-2", "object": "model", ... },
    { "id": "gpt-image-1", "object": "model", ... },
    { "id": "dall-e-3", "object": "model", ... },
    { "id": "codex-imagegen", "object": "model", ... }
  ]
}
```

---

## POST /v1/images/generations

文生图。内部执行 `codex exec` 的 `$imagegen`，从 Codex 会话或 `~/.codex/generated_images` 读取输出。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 画面描述 |
| `model` | string | 否 | 默认 `gpt-image-2`；任意 OpenAI 风格 id 均可（实际均走 Codex `$imagegen`） |
| `n` | integer | 否 | 生成张数，1–10，默认 `1` |
| `size` | string | 否 | 如 `1536x1024`，传给 Codex 提示 |
| `quality` | string | 否 | 传给 Codex 提示 |
| `output_format` | string | 否 | `png` / `jpeg` / `webp`，默认 png |
| `response_format` | string | 否 | 仅支持 `b64_json` |
| `background` | string | 否 | 传给 Codex 提示 |
| `metadata` | object | 否 | 自定义元数据（日志用） |
| `cwd` | string | 否 | Codex 工作目录，默认启动目录 |
| `sandbox` | string | 否 | `read-only` / `workspace-write` / `danger-full-access` |

### 请求示例

```bash
curl http://127.0.0.1:4100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-imagegen",
    "prompt": "电影感室内场景，暖色灯光，无文字水印",
    "size": "1536x1024",
    "n": 1,
    "response_format": "b64_json"
  }'
```

### 响应

```json
{
  "created": 1776910000,
  "data": [
    { "b64_json": "<base64>", "revised_prompt": null }
  ]
}
```

单次生成常需数分钟，代理默认超时 30 分钟。

---

## POST /v1/images/edits

带参考图的生成/编辑。至少 1 张、最多 16 张输入图。

### 输入图字段（任选一种，可混用）

| 字段 | 类型 | 说明 |
|------|------|------|
| `image` | string | 单张：本地绝对路径、`http(s)://` URL 或 `data:image/...;base64,...` |
| `images` | string[] | 多张路径 / URL / data URL |
| `input_images` | object[] | 如 `{ "path": "/abs/a.png" }`、`{ "image_url": "https://..." }` |

远程 URL 与 data URL 会先落盘为临时文件，再作为 `--image` 传给 Codex。

### 其它请求体字段

与 `POST /v1/images/generations` 相同（`prompt` 必填）。

### 请求示例

```bash
curl http://127.0.0.1:4100/v1/images/edits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-imagegen",
    "prompt": "保持人物五官，换成夜景街道背景",
    "images": [
      "/absolute/path/ref-1.png",
      "/absolute/path/ref-2.png"
    ],
    "size": "1536x1024",
    "n": 1,
    "response_format": "b64_json"
  }'
```

内部等价于：`codex exec --image <file1> --image <file2> -`，提示词经 stdin 传入。

---

## POST /v1/chat/completions

将 `messages` 转成 Codex CLI 对话。`stream: true` 当前**不支持**。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | array | 是 | `{ "role": "user"|"assistant"|"system", "content": "..." }` |
| `model` | string | 否 | 默认 `codex-cli` |
| `cwd` / `sandbox` | string | 否 | 同图片接口 |
| `metadata` | object | 否 | 自定义元数据 |

### 请求示例

```bash
curl http://127.0.0.1:4100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PRIVATE_TOKEN" \
  -d '{
    "model": "codex-cli",
    "messages": [
      { "role": "user", "content": "用一句话说明这个项目。" }
    ]
  }'
```

---

## POST /v1/responses

OpenAI Responses 形态，将 `input` / `instructions` 转成 Codex 执行。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `input` | string / array | 是 | 用户输入 |
| `instructions` | string | 否 | 系统级说明 |
| `model` | string | 否 | 默认 `codex-cli` |
| `stream` | boolean | 否 | `true` 时不支持 |

---

## GET /api/logs/days

返回按日汇总（本机免鉴权）。

**响应：**

```json
{
  "object": "list",
  "data": [
    {
      "day": "2026-05-19",
      "total": 7,
      "success": 7,
      "failed": 0,
      "input_images": 7,
      "output_images": 7
    }
  ]
}
```

---

## GET /api/logs

查询日志记录（本机免鉴权）。

### 查询参数

| 参数 | 说明 |
|------|------|
| `day` | `YYYY-MM-DD`，只读该日 `logs/YYYY-MM-DD.jsonl` |
| `limit` | 条数上限；指定 `day` 时默认 2000、最大 5000；未指定 day 时默认 100、最大 1000 |

**示例：**

```bash
curl "http://127.0.0.1:4100/api/logs?day=2026-05-19&limit=100"
```

**单条记录字段（节选）：** `request_id`、`created_at`、`endpoint`、`prompt`、`success`、`error_message`、`input_images`、`output_images`、`request_summary`。

归档图片通过 `GET /logs-assets/<相对路径>?key=...` 访问（本机可不带 key）。

---

## 配置

### `.env`（推荐）

| 变量 | 说明 |
|------|------|
| `PROXY_API_KEY` | 可选。设置后启用 HTTP Bearer 鉴权；不设则默认开放 |
| `CODEX_HOME` | Codex 数据目录，默认 `~/.codex` |
| `CODEX_BINARY` | `codex` 可执行文件路径 |

### `codex-openai-proxy.mjs` 内 `CONFIG`

端口、`defaultModel`、`requestTimeoutMs` 等可在源码 `CONFIG` 对象中调整。

---

## 与 OpenAI 官方 API 的差异

- 图片能力依赖**本机已登录的 Codex CLI**，不是 OpenAI 云端 `OPENAI_API_KEY`。
- 图片响应仅 `b64_json`，无 `url` 格式。
- 无用量/配额查询接口；额度请在 ChatGPT Codex 设置页查看。
- 日志与 `/docs` 为本地调试能力，非 OpenAI 标准。
