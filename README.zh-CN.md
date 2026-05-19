# codex2image-gen

[English README](./README.md)

基于本机已登录的 **Codex CLI**，用单个 Node.js 文件提供 **OpenAI 兼容** 的图片 API 代理。

![日志查看器](./docs/image-cn.png)

图片接口：

```text
POST /v1/images/generations
POST /v1/images/edits
```

底层通过 Codex 内置的 `$imagegen` 完成生成。

`/v1/images/edits` 最多支持 16 张参考图，例如：

- `images: ["/abs/path/a.png", "/abs/path/b.png"]`
- `image: "data:image/png;base64,..."`
- `input_images: [{ "image_url": "https://..." }, { "path": "/abs/path/ref.webp" }]`

## 文件说明

| 文件 | 说明 |
|------|------|
| `codex-openai-proxy.mjs` | 代理服务主程序 |
| `logs-viewer.html` | 内置日志查看页（中/英，随浏览器语言切换） |
| `docs/codex-openai-proxy.md` | 完整安装与 API 文档（英文） |
| `logs/` | 按天 `jsonl` 日志及归档的输入/输出图片 |

## 快速开始

**环境**：Node.js 20+，本机已安装并登录 Codex CLI。

```bash
node codex-openai-proxy.mjs
```

浏览器访问：

```text
http://localhost:4100/docs   # 文档与 API 一览（浏览器）
http://localhost:4100/logs     # 日志查看器
http://localhost:4100/health
http://localhost:4101/       # 日志页（4101 为备用端口）
```

日志页会根据浏览器语言自动显示中文或英文（`zh*` → 中文，其余 → 英文）。通过 `http://127.0.0.1:4100/logs` 打开时**无需输入 token**，自动加载左侧按日列表与统计表，点击某一天后在右侧查看详情。

## Windows

在 PowerShell 中确认 `codex` 可用后，同样执行：

```powershell
node codex-openai-proxy.mjs
```

- 完整 API（中文）：[docs/API.zh-CN.md](./docs/API.zh-CN.md)
- 安装与排错（英文）：[docs/codex-openai-proxy.md](./docs/codex-openai-proxy.md)

Windows 说明见英文文档中的 Windows 章节。

## 日志

- 每日日志：`logs/YYYY-MM-DD.jsonl`
- 参考图与生成图归档：`logs/assets/YYYY-MM-DD/<request-id>/`
- API：`GET /api/logs`
- 页面：`GET /`、`GET /logs` 打开内置日志查看器

## 安全

**默认不要求 HTTP API Key**，本机可直接调用。

若需对外或局域网暴露，复制 `.env.example` 为 `.env`，设置 `PROXY_API_KEY` 为强随机字符串后重启服务。

不要将真实令牌、公网 IP、运行日志、`.env` 或 Codex 本地数据提交到版本库。
