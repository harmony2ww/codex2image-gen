import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const proxyRoot = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(proxyRoot, ".env"));

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const defaultCodexHome = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");

const CONFIG = {
  host: "0.0.0.0",
  port: 4100,
  extraPorts: [4101],
  defaultCwd: process.cwd(),
  defaultSandbox: "read-only",
  codexBinary: process.env.CODEX_BINARY || "",
  defaultModel: "codex-cli",
  defaultImageModel: "gpt-image-2",
  requestTimeoutMs: 30 * 60 * 1000,
  requiredApiKey: process.env.PROXY_API_KEY || "",
  allowOrigin: "*",
  codexHome: defaultCodexHome,
  generatedImagesRoot: path.join(defaultCodexHome, "generated_images"),
  sessionsRoot: path.join(defaultCodexHome, "sessions"),
  logsRoot: path.join(process.cwd(), "logs"),
};

const host = CONFIG.host;
const port = CONFIG.port;
const ports = [...new Set([CONFIG.port, ...CONFIG.extraPorts])];
const defaultCwd = path.resolve(CONFIG.defaultCwd);
const defaultSandbox = CONFIG.defaultSandbox;
const configuredCodexBinary = String(CONFIG.codexBinary || "").trim();
const defaultModel = CONFIG.defaultModel;
const defaultImageModel = CONFIG.defaultImageModel;
const imageModelIds = buildImageModelIds();
const requestTimeoutMs = CONFIG.requestTimeoutMs;
const requiredApiKey = CONFIG.requiredApiKey.trim();
const allowOrigin = CONFIG.allowOrigin;
const codexHome = CONFIG.codexHome;
const generatedImagesRoot = CONFIG.generatedImagesRoot;
const sessionsRoot = CONFIG.sessionsRoot;
const logsRoot = path.resolve(CONFIG.logsRoot);
const logAssetsRoot = path.join(logsRoot, "assets");
const useShellForCodex = process.platform === "win32";

function resolveCodexBinary() {
  if (configuredCodexBinary) return configuredCodexBinary;
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "codex",
  ];
  return candidates.find((candidate) => candidate === "codex" || existsSync(candidate)) || "codex";
}

const codexBinary = resolveCodexBinary();

async function handleRequest(req, res) {
  try {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      logCorsPreflight(req);
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/logs")) {
      const html = await readFile(path.join(defaultCwd, "logs-viewer.html"), "utf8");
      return sendHtml(res, 200, html);
    }

    if (req.method === "GET" && (requestUrl.pathname === "/docs" || requestUrl.pathname.startsWith("/docs/"))) {
      return handleDocsRequest(res, requestUrl);
    }

    if (!authorizeRequest(req, requestUrl) && !isLocalPublicBrowseRequest(req, requestUrl)) {
      return sendOpenAiError(res, 401, "invalid_api_key", "Invalid or missing API key.");
    }

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "codex2image-gen",
        codexBinary,
        defaultModel,
        defaultImageModel,
        imageModels: imageModelIds,
        imageBackend: "codex-builtin",
        imageModelNote:
          "Image routes use Codex $imagegen; model id is accepted for OpenAI compatibility only.",
        defaultSandbox,
        defaultCwd,
        codexHome,
        generatedImagesRoot,
        sessionsRoot,
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
      return sendJson(res, 200, buildModelsResponse());
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
      return handleChatCompletions(req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/responses") {
      return handleResponses(req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/images/generations") {
      return handleImageGenerations(req, res);
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/images/edits") {
      return handleImageEdits(req, res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/logs/days") {
      return handleLogsDays(res);
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/logs") {
      return handleLogsList(res, requestUrl);
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith("/logs-assets/")) {
      return handleLogAsset(req, res, requestUrl);
    }

    return sendOpenAiError(res, 404, "not_found_error", "Unknown endpoint.");
  } catch (error) {
    console.error(error);
    applyCors(req, res);
    return sendOpenAiError(res, 500, "server_error", "Unexpected server error.");
  }
}

for (const listenPort of ports) {
  createServer(handleRequest).listen(listenPort, host, () => {
    console.log(`Codex OpenAI proxy listening on http://${host}:${listenPort}`);
    console.log(
      requiredApiKey
        ? "Proxy API key auth: enabled (PROXY_API_KEY)"
        : "Proxy API key auth: disabled (optional: set PROXY_API_KEY in .env)",
    );
  });
}

async function handleChatCompletions(req, res) {
  const body = await tryReadRequestJson(req, res);
  if (!body) {
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendOpenAiError(res, 400, "invalid_request_error", "messages must be a non-empty array.");
  }

  let prompt;
  try {
    prompt = buildChatPrompt(body.messages);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  const stream = body.stream === true;
  const effectiveModel = normalizeModel(body.model);
  const executionOptions = resolveExecutionOptions(body);
  const created = Math.floor(Date.now() / 1000);

  let result;
  try {
    result = await runCodex(prompt, {
      model: effectiveModel,
      cwd: executionOptions.cwd,
      sandbox: executionOptions.sandbox,
    });
  } catch (error) {
    return sendOpenAiError(res, 500, "server_error", error.message);
  }

  if (stream) {
    return sendChatCompletionStream(res, {
      content: result.content,
      created,
      model: effectiveModel,
      responseId: makeId("chatcmpl"),
    });
  }

  return sendJson(res, 200, {
    id: makeId("chatcmpl"),
    object: "chat.completion",
    created,
    model: effectiveModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: buildChatUsage(result.totalTokens),
  });
}

async function handleResponses(req, res) {
  const body = await tryReadRequestJson(req, res);
  if (!body) {
    return;
  }

  if (body.stream === true) {
    return sendOpenAiError(
      res,
      400,
      "invalid_request_error",
      "Streaming is not implemented for /v1/responses in this local proxy.",
    );
  }

  let prompt;
  try {
    prompt = buildResponsesPrompt(body);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  const effectiveModel = normalizeModel(body.model);
  const executionOptions = resolveExecutionOptions(body);

  let result;
  try {
    result = await runCodex(prompt, {
      model: effectiveModel,
      cwd: executionOptions.cwd,
      sandbox: executionOptions.sandbox,
    });
  } catch (error) {
    return sendOpenAiError(res, 500, "server_error", error.message);
  }

  const created = Math.floor(Date.now() / 1000);
  const messageId = makeId("msg");

  return sendJson(res, 200, {
    id: makeId("resp"),
    object: "response",
    created_at: created,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    model: effectiveModel,
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: result.content,
            annotations: [],
          },
        ],
      },
    ],
    output_text: result.content,
    parallel_tool_calls: false,
    tool_choice: "none",
    tools: [],
    usage: buildResponsesUsage(result.totalTokens),
    metadata: isPlainObject(body.metadata) ? body.metadata : {},
  });
}

async function handleImageGenerations(req, res) {
  const body = await tryReadRequestJson(req, res);
  if (!body) {
    return;
  }

  const logContext = createRequestLogContext(req, "images.generations", body);

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAiError(res, 400, "invalid_request_error", "prompt is required.");
  }

  if (body.response_format && body.response_format !== "b64_json") {
    return sendOpenAiError(
      res,
      400,
      "invalid_request_error",
      "Only response_format='b64_json' is supported by this local proxy.",
    );
  }

  const effectiveModel = normalizeImageModel(body.model);
  let imageCount;
  try {
    imageCount = normalizeImageCount(body.n);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  let outputFormat;
  try {
    outputFormat = normalizeImageOutputFormat(body.output_format);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  let result;
  try {
    result = await runCodexBuiltinImageGeneration(prompt, body, {
      model: effectiveModel,
      n: imageCount,
      outputFormat,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeWriteImageRequestLog(logContext, {
      prompt,
      success: false,
      errorMessage: message,
      inputImages: [],
      outputs: [],
      requestBody: body,
    });
    return sendOpenAiError(res, 500, "server_error", message);
  }

  await safeWriteImageRequestLog(logContext, {
    prompt,
    success: true,
    errorMessage: null,
    inputImages: [],
    outputs: result.images,
    requestBody: body,
  });

  return sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: result.images.map((image) => ({
      b64_json: image.b64Json,
      revised_prompt: null,
    })),
  });
}

async function handleImageEdits(req, res) {
  const body = await tryReadRequestJson(req, res);
  if (!body) {
    return;
  }

  const logContext = createRequestLogContext(req, "images.edits", body);

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAiError(res, 400, "invalid_request_error", "prompt is required.");
  }

  let inputImages;
  try {
    inputImages = normalizeInputImages(body);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  if (inputImages.length === 0) {
    return sendOpenAiError(
      res,
      400,
      "invalid_request_error",
      "At least one input image is required for /v1/images/edits.",
    );
  }

  if (body.response_format && body.response_format !== "b64_json") {
    return sendOpenAiError(
      res,
      400,
      "invalid_request_error",
      "Only response_format='b64_json' is supported by this local proxy.",
    );
  }

  const effectiveModel = normalizeImageModel(body.model);
  let outputFormat;
  try {
    outputFormat = normalizeImageOutputFormat(body.output_format);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  let imageCount;
  try {
    imageCount = normalizeImageCount(body.n);
  } catch (error) {
    return sendOpenAiError(res, 400, "invalid_request_error", error.message);
  }

  let result;
  try {
    result = await runCodexBuiltinImageGeneration(prompt, body, {
      model: effectiveModel,
      n: imageCount,
      outputFormat,
      inputImages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await safeWriteImageRequestLog(logContext, {
      prompt,
      success: false,
      errorMessage: message,
      inputImages,
      outputs: [],
      requestBody: body,
    });
    return sendOpenAiError(res, 500, "server_error", message);
  }

  await safeWriteImageRequestLog(logContext, {
    prompt,
    success: true,
    errorMessage: null,
    inputImages,
    outputs: result.images,
    requestBody: body,
  });

  return sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: result.images.map((image) => ({
      b64_json: image.b64Json,
      revised_prompt: null,
    })),
  });
}

async function handleLogsList(res, requestUrl) {
  const day = String(requestUrl.searchParams.get("day") || "").trim();
  const limit = normalizeLogsLimit(requestUrl.searchParams.get("limit"), { day });
  const records = await readLogRecords({ day, limit });
  return sendJson(res, 200, {
    object: "list",
    data: records,
  });
}

async function handleLogsDays(res) {
  const days = await readLogDaysSummary();
  return sendJson(res, 200, {
    object: "list",
    data: days,
  });
}

async function handleDocsRequest(res, requestUrl) {
  const docsRoot = path.join(defaultCwd, "docs");
  let relativePath = requestUrl.pathname.replace(/^\/docs\/?/, "");
  if (!relativePath) {
    relativePath = "index.html";
  }

  const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(docsRoot, safeRelativePath);
  const expectedRoot = `${docsRoot}${path.sep}`;
  if (!filePath.startsWith(expectedRoot)) {
    return sendOpenAiError(res, 404, "not_found_error", "Document not found.");
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return sendOpenAiError(res, 404, "not_found_error", "Document not found.");
    }
    const bytes = await readFile(filePath);
    const contentType = mimeTypeForDocsPath(filePath);
    if (contentType === "text/html; charset=utf-8") {
      return sendHtml(res, 200, bytes.toString("utf8"));
    }
    if (contentType.startsWith("text/")) {
      res.writeHead(200, { "content-type": contentType });
      res.end(bytes);
      return;
    }
    return sendBinary(res, 200, bytes, contentType);
  } catch {
    return sendOpenAiError(res, 404, "not_found_error", "Document not found.");
  }
}

async function handleLogAsset(req, res, requestUrl) {
  const assetRelativePath = decodeURIComponent(requestUrl.pathname.replace(/^\/logs-assets\//, ""));
  const candidatePath = path.resolve(logAssetsRoot, assetRelativePath);
  const expectedRoot = `${logAssetsRoot}${path.sep}`;
  if (!candidatePath.startsWith(expectedRoot)) {
    return sendOpenAiError(res, 400, "invalid_request_error", "Invalid asset path.");
  }

  try {
    const fileStat = await stat(candidatePath);
    if (!fileStat.isFile() || !isImagePath(candidatePath)) {
      return sendOpenAiError(res, 404, "not_found_error", "Asset not found.");
    }
    const bytes = await readFile(candidatePath);
    return sendBinary(res, 200, bytes, mimeTypeForImagePath(candidatePath));
  } catch {
    return sendOpenAiError(res, 404, "not_found_error", "Asset not found.");
  }
}

function normalizeModel(model) {
  const trimmed = String(model || "").trim();
  return trimmed || defaultModel;
}

function buildImageModelIds() {
  const base = [
    defaultImageModel,
    "gpt-image-2",
    "gpt-image-1",
    "dall-e-3",
    "dall-e-2",
    "codex-imagegen",
  ];
  const extra = String(process.env.EXTRA_IMAGE_MODELS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...base, ...extra])];
}

function buildModelsResponse() {
  const created = Math.floor(Date.now() / 1000);
  const makeEntry = (id) => ({
    id,
    object: "model",
    created,
    owned_by: "local-codex-proxy",
  });

  const ids = new Set();
  const data = [];

  const pushId = (id) => {
    const trimmed = String(id || "").trim();
    if (!trimmed || ids.has(trimmed)) {
      return;
    }
    ids.add(trimmed);
    data.push(makeEntry(trimmed));
  };

  pushId(defaultModel);
  for (const id of imageModelIds) {
    pushId(id);
  }

  return { object: "list", data };
}

/** Image generation ignores model id at the Codex layer; any id is accepted for API compatibility. */
function normalizeImageModel(model) {
  const trimmed = String(model || "").trim();
  return trimmed || defaultImageModel;
}

function resolveExecutionOptions(body) {
  const metadata = isPlainObject(body.metadata) ? body.metadata : {};
  const requestedCwd = body.cwd || metadata.cwd || defaultCwd;
  const requestedSandbox = body.sandbox || metadata.sandbox || defaultSandbox;

  const cwd = path.resolve(String(requestedCwd));
  const sandbox = String(requestedSandbox || defaultSandbox);

  return { cwd, sandbox };
}

function buildChatPrompt(messages) {
  const parts = [
    "You are acting as the assistant in a chat-completions style conversation.",
    "Return only the next assistant reply.",
    "",
  ];

  for (const message of messages) {
    if (!isPlainObject(message) || typeof message.role !== "string") {
      throw new Error("Each message must be an object with a role.");
    }

    const role = message.role.trim() || "user";
    const content = extractTextContent(message.content);
    parts.push(`[${role}]`);
    parts.push(content || "");
    parts.push("");
  }

  parts.push("[assistant]");
  return parts.join("\n");
}

function buildResponsesPrompt(body) {
  const parts = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    parts.push("System instructions:");
    parts.push(body.instructions.trim());
    parts.push("");
  }

  parts.push("User input:");
  parts.push(extractResponsesInput(body.input));

  return parts.join("\n");
}

function extractResponsesInput(input) {
  if (typeof input === "string" && input.trim()) {
    return input.trim();
  }

  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("input must be a non-empty string or array.");
  }

  const parts = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      parts.push(item.trim());
      continue;
    }

    if (!isPlainObject(item)) {
      throw new Error("Each input item must be a string or object.");
    }

    if (Array.isArray(item.content)) {
      const joined = item.content
        .map((part) => {
          if (typeof part === "string") {
            return part.trim();
          }

          if (!isPlainObject(part)) {
            return "";
          }

          if (part.type === "input_text" || part.type === "text") {
            return String(part.text || "").trim();
          }

          throw new Error(`Unsupported responses input content part type: ${String(part.type)}`);
        })
        .filter(Boolean)
        .join("\n");

      if (joined) {
        parts.push(joined);
      }

      continue;
    }

    if (item.type === "input_text" || item.type === "text") {
      parts.push(String(item.text || "").trim());
      continue;
    }

    throw new Error(`Unsupported responses input item type: ${String(item.type || "unknown")}`);
  }

  const combined = parts.filter(Boolean).join("\n\n").trim();
  if (!combined) {
    throw new Error("No text input was found.");
  }

  return combined;
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    throw new Error("message.content must be a string or an array of text parts.");
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part.trim();
      }

      if (!isPlainObject(part)) {
        return "";
      }

      if (part.type === "text" || part.type === "input_text") {
        return String(part.text || "").trim();
      }

      throw new Error(`Unsupported message content part type: ${String(part.type || "unknown")}`);
    })
    .filter(Boolean)
    .join("\n");
}

async function runCodex(prompt, options) {
  const cwd = path.resolve(options.cwd || defaultCwd);
  const sandbox = String(options.sandbox || defaultSandbox);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-openai-proxy-"));
  const outputPath = path.join(tempDir, "last-message.txt");
  const effectiveModel = options.model && options.model !== "codex-cli" ? options.model : null;

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    sandbox,
    "-o",
    outputPath,
  ];

  if (effectiveModel) {
    args.push("-m", effectiveModel);
  }

  args.push(prompt);

  const child = spawn(codexBinary, args, {
    cwd,
    env: process.env,
    shell: useShellForCodex,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, requestTimeoutMs);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const totalTokens = parseTokenCount(stderr);

    let content = "";
    try {
      content = (await readFile(outputPath, "utf8")).trim();
    } catch {
      content = stdout.trim();
    }

    if (exitCode !== 0) {
      throw new Error(buildCodexFailureMessage(stderr, stdout, exitCode));
    }

    if (!content) {
      throw new Error("Codex returned an empty response.");
    }

    return {
      content,
      stdout,
      stderr,
      totalTokens,
    };
  } finally {
    clearTimeout(timeout);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runCodexBuiltinImageGeneration(prompt, body, options) {
  const images = [];
  const materializedInputs = await materializeInputImages(options.inputImages || []);

  try {
    for (let i = 1; i <= options.n; i += 1) {
      const startedAt = Date.now();
      const codexPrompt = buildCodexImagePrompt(prompt, body, options, i);
      const runResult = await runCodexImagePrompt(codexPrompt, startedAt, {
        imagePaths: materializedInputs.imagePaths,
      });

      if (runResult.b64Json) {
        images.push({
          b64Json: runResult.b64Json,
        });
        continue;
      }

      const bytes = await readFile(runResult.imagePath);
      images.push({
        b64Json: bytes.toString("base64"),
      });
    }
  } finally {
    await materializedInputs.cleanup();
  }

  return { images };
}

function buildCodexImagePrompt(prompt, body, options, index) {
  const parts = [
    "$imagegen",
    prompt,
    "",
    "Use the built-in image_gen tool, not the fallback CLI.",
    "Render the image only; no text response is needed.",
  ];

  if (options.n > 1) {
    parts.push(`Variant ${index} of ${options.n}; make it visually distinct while preserving the request.`);
  }

  const optionLines = [];
  if (body.size !== undefined) {
    optionLines.push(`Requested size: ${String(body.size)}`);
  }
  if (body.quality !== undefined) {
    optionLines.push(`Requested quality: ${String(body.quality)}`);
  }
  if (body.output_format !== undefined) {
    optionLines.push(`Requested output format: ${String(body.output_format)}`);
  }
  if (body.background !== undefined) {
    optionLines.push(`Requested background: ${String(body.background)}`);
  }

  if (optionLines.length) {
    parts.push("");
    parts.push("API request hints:");
    parts.push(...optionLines);
  }

  addCodexImagePromptField(parts, "Use case", body.use_case);
  addCodexImagePromptField(parts, "Scene/background", body.scene);
  addCodexImagePromptField(parts, "Subject", body.subject);
  addCodexImagePromptField(parts, "Style/medium", body.style);
  addCodexImagePromptField(parts, "Composition/framing", body.composition);
  addCodexImagePromptField(parts, "Lighting/mood", body.lighting);
  addCodexImagePromptField(parts, "Color palette", body.palette);
  addCodexImagePromptField(parts, "Materials/textures", body.materials);
  addCodexImagePromptField(parts, "Text", body.text);
  addCodexImagePromptField(parts, "Constraints", body.constraints);
  addCodexImagePromptField(parts, "Avoid", body.negative);

  if ((options.inputImages || []).length > 0) {
    parts.push("");
    parts.push(
      `There are ${(options.inputImages || []).length} attached reference image(s). Use them as visual input.`,
    );
    parts.push("Preserve important subject identity, composition, and visual cues from the references when relevant.");
  }

  return parts.join("\n");
}

function addCodexImagePromptField(parts, label, value) {
  if (value !== undefined && value !== null && String(value).trim()) {
    parts.push(`${label}: ${String(value).trim()}`);
  }
}

async function runCodexImagePrompt(codexPrompt, startedAt, options = {}) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    defaultSandbox,
  ];

  for (const imagePath of options.imagePaths || []) {
    args.push("--image", imagePath);
  }

  args.push("-");

  const child = spawn(codexBinary, args, {
    cwd: defaultCwd,
    env: process.env,
    shell: useShellForCodex,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  child.stdin.end(codexPrompt);

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, requestTimeoutMs);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    if (exitCode !== 0) {
      throw new Error(buildCodexFailureMessage(stderr, stdout, exitCode));
    }

    const combinedOutput = `${stderr}\n${stdout}`;
    const sessionId = extractCodexSessionId(combinedOutput);
    const artifacts = await retryUntilValue(
      () => findGeneratedImageArtifactsForCodexRun(sessionId),
      8_000,
      250,
    );
    if (artifacts?.b64Json) {
      return { b64Json: artifacts.b64Json, imagePath: null, stdout, stderr };
    }

    const sessionImagePath = await firstExistingImagePath(artifacts?.savedPaths || []);
    if (sessionImagePath) {
      return { b64Json: null, imagePath: sessionImagePath, stdout, stderr };
    }

    const outputImagePath = await firstExistingImagePath(extractImagePathsFromText(combinedOutput));
    if (outputImagePath) {
      return { b64Json: null, imagePath: outputImagePath, stdout, stderr };
    }

    const imagePath = await retryUntilValue(
      () => findGeneratedImageForCodexRun(sessionId, startedAt),
      8_000,
      250,
    );
    if (!imagePath) {
      throw new Error(
        await buildImageNotFoundMessage({
          sessionId,
          sessionFilePath: artifacts?.sessionFilePath || await findCodexSessionFile(sessionId),
          savedPaths: artifacts?.savedPaths || [],
          stdout,
          stderr,
        }),
      );
    }

    return { b64Json: null, imagePath, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function extractCodexSessionId(stderr) {
  const match = stderr.match(/session id:\s*([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

async function findGeneratedImageArtifactsForCodexRun(sessionId) {
  if (!sessionId) {
    return null;
  }

  const sessionFilePath = await findCodexSessionFile(sessionId);
  if (!sessionFilePath) {
    return null;
  }

  const artifacts = await extractLatestImageArtifactsFromSessionFile(sessionFilePath);
  if (!artifacts.b64Json && artifacts.savedPaths.length === 0) {
    return null;
  }

  return {
    sessionFilePath,
    ...artifacts,
  };
}

async function findCodexSessionFile(sessionId) {
  const stack = [sessionsRoot];
  let newest = null;

  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(sessionId)) {
        continue;
      }

      const fileStat = await stat(entryPath);
      if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
        newest = { filePath: entryPath, mtimeMs: fileStat.mtimeMs };
      }
    }
  }

  return newest?.filePath || null;
}

async function extractLatestImageArtifactsFromSessionFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  let b64Json = null;
  const savedPaths = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes("image_generation")) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = isPlainObject(record.payload) ? record.payload : record;
    if (payload.type !== "image_generation_end") {
      continue;
    }

    const payloadResult = normalizeImageBase64(payload.result || payload.b64_json || "");
    if (looksLikeImageBase64(payloadResult)) {
      b64Json = payloadResult;
    }

    if (typeof payload.saved_path === "string" && isImagePath(payload.saved_path)) {
      savedPaths.push(payload.saved_path);
    }
  }

  return {
    b64Json,
    savedPaths: uniqueStrings(savedPaths),
  };
}

function normalizeImageBase64(value) {
  const trimmed = String(value || "").trim();
  const dataUrlMatch = trimmed.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  return dataUrlMatch ? dataUrlMatch[1].trim() : trimmed;
}

function looksLikeImageBase64(value) {
  return (
    value.length > 1000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    (value.startsWith("iVBOR") || value.startsWith("/9j/") || value.startsWith("UklGR"))
  );
}

function extractImagePathsFromText(text) {
  const raw = String(text || "");
  if (raw.length > 20_000) {
    return [];
  }

  const normalized = raw.replaceAll("\\\\", "\\");
  const paths = [];
  const regex = /(?:[A-Za-z]:\\|\/)[^\r\n"'<>|]*?\.(?:png|jpe?g|webp)/gi;
  let match;

  while ((match = regex.exec(normalized))) {
    const cleaned = match[0].replace(/[),.;\]]+$/g, "");
    if (isImagePath(cleaned)) {
      paths.push(cleaned);
    }
  }

  return uniqueStrings(paths);
}

async function firstExistingImagePath(paths) {
  for (const filePath of paths) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile() && isImagePath(filePath)) {
        return filePath;
      }
    } catch {
      // Ignore stale paths; the generated-images directory fallback handles the normal case.
    }
  }

  return null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

async function buildImageNotFoundMessage({ sessionId, sessionFilePath, savedPaths, stdout, stderr }) {
  const latestImages = await listNewestGeneratedImagePaths(5);
  const details = [
    "Codex built-in imagegen completed but no generated image file was found.",
    `sessionId: ${sessionId || "(not found in codex output)"}`,
    `codexHome: ${codexHome}`,
    `generatedImagesRoot: ${generatedImagesRoot}`,
    `sessionsRoot: ${sessionsRoot}`,
    `sessionFile: ${sessionFilePath || "(not found)"}`,
    `savedPathsInSession: ${savedPaths.length ? savedPaths.join(" | ") : "(none)"}`,
    `newestGeneratedImages: ${latestImages.length ? latestImages.join(" | ") : "(none found)"}`,
    `stderrTail: ${trimForDiagnostics(stderr)}`,
    `stdoutTail: ${trimForDiagnostics(stdout)}`,
  ];

  return details.join("\n");
}

async function listNewestGeneratedImagePaths(limit) {
  let sessionDirs;
  try {
    sessionDirs = await readdir(generatedImagesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const images = [];
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) {
      continue;
    }

    const directory = path.join(generatedImagesRoot, sessionDir.name);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      if (!isImagePath(filePath)) {
        continue;
      }

      const fileStat = await stat(filePath);
      images.push({ filePath, mtimeMs: fileStat.mtimeMs });
    }
  }

  return images
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((image) => image.filePath);
}

function trimForDiagnostics(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return "(empty)";
  }

  return text.length > 1_200 ? `...${text.slice(-1_200)}` : text;
}

async function findGeneratedImageForCodexRun(sessionId, startedAt) {
  if (sessionId) {
    const sessionDir = path.join(generatedImagesRoot, sessionId);
    const image = await newestImageInDirectory(sessionDir);
    if (image) {
      return image;
    }
  }

  return newestGeneratedImageSince(startedAt);
}

async function newestImageInDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    if (!isImagePath(filePath)) {
      continue;
    }

    const fileStat = await stat(filePath);
    if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
      newest = { filePath, mtimeMs: fileStat.mtimeMs };
    }
  }

  return newest?.filePath || null;
}

async function newestGeneratedImageSince(startedAt) {
  let sessionDirs;
  try {
    sessionDirs = await readdir(generatedImagesRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) {
      continue;
    }

    const directory = path.join(generatedImagesRoot, sessionDir.name);
    const imagePath = await newestImageInDirectory(directory);
    if (!imagePath) {
      continue;
    }

    const fileStat = await stat(imagePath);
    if (fileStat.mtimeMs < startedAt - 1000) {
      continue;
    }

    if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
      newest = { filePath: imagePath, mtimeMs: fileStat.mtimeMs };
    }
  }

  return newest?.filePath || null;
}

function isImagePath(filePath) {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(filePath).toLowerCase());
}

async function retryUntilValue(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      // Codex writes session logs and generated files asynchronously on some platforms.
    }

    await delay(intervalMs);
  }

  return null;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeImageOutputFormat(outputFormat) {
  const trimmed = String(outputFormat || "").trim().toLowerCase();
  if (!trimmed) {
    return "png";
  }

  if (!["png", "jpeg", "jpg", "webp"].includes(trimmed)) {
    throw new Error("output_format must be png, jpeg, jpg, or webp.");
  }

  return trimmed === "jpg" ? "jpeg" : trimmed;
}

function normalizeImageCount(n) {
  const parsed = Number.parseInt(String(n ?? "1"), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("n must be an integer between 1 and 10.");
  }
  return parsed;
}

function createRequestLogContext(req, endpoint, body) {
  const now = new Date();
  return {
    requestId: randomUUID(),
    endpoint,
    createdAt: now.toISOString(),
    day: now.toISOString().slice(0, 10),
    clientIp: String(req.socket.remoteAddress || ""),
    userAgent: String(req.headers["user-agent"] || ""),
    authMode: detectAuthMode(req),
    model: String(body.model || "").trim() || defaultImageModel,
  };
}

async function writeImageRequestLog(context, payload) {
  await ensureLogsDirectories();

  const assetDirectory = path.join(logAssetsRoot, context.day, context.requestId);
  await mkdir(assetDirectory, { recursive: true });

  const savedInputs = [];
  for (let i = 0; i < payload.inputImages.length; i += 1) {
    savedInputs.push(await persistReferenceImage(payload.inputImages[i], assetDirectory, i));
  }

  const savedOutputs = [];
  for (let i = 0; i < payload.outputs.length; i += 1) {
    savedOutputs.push(await persistGeneratedImage(payload.outputs[i], assetDirectory, i));
  }

  const record = {
    request_id: context.requestId,
    created_at: context.createdAt,
    day: context.day,
    endpoint: context.endpoint,
    client_ip: context.clientIp,
    user_agent: context.userAgent,
    auth_mode: context.authMode,
    model: context.model,
    prompt: payload.prompt,
    success: payload.success,
    error_message: payload.errorMessage,
    input_image_count: savedInputs.length,
    output_image_count: savedOutputs.length,
    input_images: savedInputs,
    output_images: savedOutputs,
    request_summary: buildRequestSummary(payload.requestBody),
  };

  const logFilePath = path.join(logsRoot, `${context.day}.jsonl`);
  await appendFile(logFilePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function safeWriteImageRequestLog(context, payload) {
  try {
    await writeImageRequestLog(context, payload);
  } catch (error) {
    console.error("Failed to write image request log:", error);
  }
}

async function persistReferenceImage(input, assetDirectory, index) {
  if (input.kind === "file-path") {
    const resolved = path.resolve(input.value);
    const ext = normalizeKnownImageExtension(path.extname(resolved));
    const outputPath = path.join(assetDirectory, `input-${index + 1}${ext}`);
    await copyFile(resolved, outputPath);
    return {
      index,
      kind: input.kind,
      source: resolved,
      saved_path: outputPath,
      public_path: buildLogAssetPublicPath(outputPath),
      sha256: await sha256File(outputPath),
    };
  }

  const { bytes, extension, source } = await materializeLogImageBytes(input);
  const outputPath = path.join(assetDirectory, `input-${index + 1}${extension}`);
  await writeFile(outputPath, bytes);
  return {
    index,
    kind: input.kind,
    source,
    saved_path: outputPath,
    public_path: buildLogAssetPublicPath(outputPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function persistGeneratedImage(output, assetDirectory, index) {
  const extension = detectOutputImageExtension(output.b64Json);
  const bytes = Buffer.from(output.b64Json, "base64");
  const outputPath = path.join(assetDirectory, `output-${index + 1}${extension}`);
  await writeFile(outputPath, bytes);
  return {
    index,
    saved_path: outputPath,
    public_path: buildLogAssetPublicPath(outputPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function materializeLogImageBytes(input) {
  if (input.kind === "remote-url") {
    const response = await fetch(input.value);
    if (!response.ok) {
      throw new Error(`Failed to download input image for logging: ${input.value} (${response.status})`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      extension: guessImageExtensionFromMime(
        response.headers.get("content-type"),
        path.extname(new URL(input.value).pathname),
      ),
      source: input.value,
    };
  }

  if (input.kind === "data-url") {
    const match = input.value.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (!match) {
      throw new Error("Unsupported data URL input image for logging.");
    }

    return {
      bytes: Buffer.from(match[2], "base64"),
      extension: normalizeKnownImageExtension(`.${match[1].toLowerCase()}`),
      source: "data-url",
    };
  }

  if (input.kind === "base64") {
    return {
      bytes: Buffer.from(input.value, "base64"),
      extension: ".png",
      source: "base64",
    };
  }

  throw new Error(`Unsupported input image kind for logging: ${input.kind}`);
}

async function ensureLogsDirectories() {
  await mkdir(logsRoot, { recursive: true });
  await mkdir(logAssetsRoot, { recursive: true });
}

async function readLogDaysSummary() {
  await ensureLogsDirectories();
  const files = await listLogFiles("");
  const summaries = [];

  for (const filePath of files) {
    const day = path.basename(filePath, ".jsonl");
    const summary = {
      day,
      total: 0,
      success: 0,
      failed: 0,
      input_images: 0,
      output_images: 0,
    };

    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      summaries.push(summary);
      continue;
    }

    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        summary.total += 1;
        if (record.success) {
          summary.success += 1;
        } else {
          summary.failed += 1;
        }
        summary.input_images += Number(record.input_image_count) || 0;
        summary.output_images += Number(record.output_image_count) || 0;
      } catch {
        // Ignore malformed lines.
      }
    }

    summaries.push(summary);
  }

  return summaries;
}

async function readLogRecords({ day, limit }) {
  await ensureLogsDirectories();
  const files = await listLogFiles(day);
  const records = [];

  for (const filePath of files) {
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        records.push(JSON.parse(lines[i]));
      } catch {
        // Ignore malformed lines.
      }

      if (records.length >= limit) {
        return records;
      }
    }
  }

  return records;
}

async function listLogFiles(day) {
  if (day) {
    const safeDay = normalizeLogDay(day);
    return safeDay ? [path.join(logsRoot, `${safeDay}.jsonl`)] : [];
  }

  const entries = await readdir(logsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => path.join(logsRoot, entry.name))
    .sort()
    .reverse();
}

function normalizeLogsLimit(value, options = {}) {
  const defaultLimit = options.day ? 2000 : 100;
  const maxLimit = options.day ? 5000 : 1000;
  const parsed = Number.parseInt(String(value || defaultLimit), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultLimit;
  }

  return Math.min(parsed, maxLimit);
}

function normalizeLogDay(value) {
  const trimmed = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

function buildRequestSummary(body) {
  return {
    n: body.n ?? 1,
    size: body.size ?? null,
    quality: body.quality ?? null,
    output_format: body.output_format ?? null,
    background: body.background ?? null,
    image_fields_present: {
      image: body.image !== undefined,
      images: Array.isArray(body.images) ? body.images.length : body.images !== undefined,
      input_images: Array.isArray(body.input_images) ? body.input_images.length : body.input_images !== undefined,
    },
  };
}

function buildLogAssetPublicPath(filePath) {
  const relativePath = path.relative(logAssetsRoot, filePath).split(path.sep).join("/");
  return `/logs-assets/${relativePath}`;
}

function detectAuthMode(req) {
  if (String(req.headers.authorization || "").startsWith("Bearer ")) {
    return "bearer";
  }
  if (String(req.headers["x-api-key"] || "").trim()) {
    return "x-api-key";
  }
  return "query";
}

function normalizeKnownImageExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (normalized === ".jpg") {
    return ".jpeg";
  }
  return [".png", ".jpeg", ".webp"].includes(normalized) ? normalized : ".png";
}

function detectOutputImageExtension(base64Value) {
  const normalized = String(base64Value || "").trim();
  if (normalized.startsWith("iVBOR")) {
    return ".png";
  }
  if (normalized.startsWith("/9j/")) {
    return ".jpeg";
  }
  if (normalized.startsWith("UklGR")) {
    return ".webp";
  }
  return ".png";
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function mimeTypeForImagePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpeg" || ext === ".jpg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function normalizeInputImages(body) {
  const rawValues = [];
  pushImageInput(rawValues, body.image);
  pushImageInput(rawValues, body.images);
  pushImageInput(rawValues, body.input_images);

  if (rawValues.length > 16) {
    throw new Error("A maximum of 16 input images is supported.");
  }

  return rawValues.map(normalizeImageInputValue);
}

function pushImageInput(target, value) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      pushImageInput(target, item);
    }
    return;
  }

  target.push(value);
}

function normalizeImageInputValue(value) {
  if (typeof value === "string" && value.trim()) {
    return {
      kind: classifyImageInputString(value.trim()),
      value: value.trim(),
    };
  }

  if (!isPlainObject(value)) {
    throw new Error("Each input image must be a string or object.");
  }

  const candidate = [
    value.image_url,
    value.url,
    value.path,
    value.file_path,
    value.data_uri,
    value.b64_json,
  ].find((item) => typeof item === "string" && item.trim());

  if (!candidate) {
    throw new Error("Unsupported input image object. Expected image_url, url, path, file_path, data_uri, or b64_json.");
  }

  const trimmed = String(candidate).trim();
  if (candidate === value.b64_json) {
    return {
      kind: "base64",
      value: trimmed,
    };
  }

  return {
    kind: classifyImageInputString(trimmed),
    value: trimmed,
  };
}

function classifyImageInputString(value) {
  if (/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value)) {
    return "data-url";
  }

  if (/^https?:\/\//i.test(value)) {
    return "remote-url";
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 100) {
    return "base64";
  }

  return "file-path";
}

async function materializeInputImages(inputImages) {
  if (!inputImages.length) {
    return {
      imagePaths: [],
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-openai-proxy-images-"));
  const imagePaths = [];

  try {
    for (let i = 0; i < inputImages.length; i += 1) {
      const input = inputImages[i];
      const materialized = await materializeSingleInputImage(input, tempDir, i);
      imagePaths.push(materialized);
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    imagePaths,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function materializeSingleInputImage(input, tempDir, index) {
  if (input.kind === "file-path") {
    const resolved = path.resolve(input.value);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || !isImagePath(resolved)) {
      throw new Error(`Input image is not a supported local image file: ${resolved}`);
    }
    return resolved;
  }

  if (input.kind === "remote-url") {
    const response = await fetch(input.value);
    if (!response.ok) {
      throw new Error(`Failed to download input image: ${input.value} (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const extension = guessImageExtensionFromMime(
      response.headers.get("content-type"),
      path.extname(new URL(input.value).pathname),
    );
    const filePath = path.join(tempDir, `input-${index + 1}${extension}`);
    await writeFile(filePath, buffer);
    return filePath;
  }

  if (input.kind === "data-url") {
    const match = input.value.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (!match) {
      throw new Error("Unsupported data URL input image.");
    }

    const extension = match[1].toLowerCase() === "jpg" ? ".jpeg" : `.${match[1].toLowerCase()}`;
    const filePath = path.join(tempDir, `input-${index + 1}${extension}`);
    await writeFile(filePath, Buffer.from(match[2], "base64"));
    return filePath;
  }

  if (input.kind === "base64") {
    const filePath = path.join(tempDir, `input-${index + 1}.png`);
    await writeFile(filePath, Buffer.from(input.value, "base64"));
    return filePath;
  }

  throw new Error(`Unsupported input image kind: ${input.kind}`);
}

function guessImageExtensionFromMime(contentType, fallbackExt) {
  const normalizedContentType = String(contentType || "").toLowerCase();
  if (normalizedContentType.includes("image/png")) {
    return ".png";
  }
  if (normalizedContentType.includes("image/jpeg") || normalizedContentType.includes("image/jpg")) {
    return ".jpeg";
  }
  if (normalizedContentType.includes("image/webp")) {
    return ".webp";
  }

  const normalizedFallbackExt = String(fallbackExt || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(normalizedFallbackExt)) {
    return normalizedFallbackExt === ".jpg" ? ".jpeg" : normalizedFallbackExt;
  }

  return ".png";
}

function buildCodexFailureMessage(stderr, stdout, exitCode) {
  const detail = stderr.trim() || stdout.trim() || `codex exited with code ${exitCode}`;
  return `Codex execution failed: ${detail}`;
}

function parseTokenCount(stderr) {
  const match = stderr.match(/tokens used\s+([\d,]+)/i);
  if (!match) {
    return 0;
  }

  return Number.parseInt(match[1].replaceAll(",", ""), 10) || 0;
}

function buildChatUsage(totalTokens) {
  return {
    prompt_tokens: 0,
    completion_tokens: totalTokens,
    total_tokens: totalTokens,
  };
}

function buildResponsesUsage(totalTokens) {
  return {
    input_tokens: 0,
    output_tokens: totalTokens,
    total_tokens: totalTokens,
  };
}

function sendChatCompletionStream(res, { content, created, model, responseId }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeSse(res, {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  });

  writeSse(res, {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  });

  writeSse(res, {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });

  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isLoopbackRequest(req) {
  const addr = String(req.socket?.remoteAddress || "");
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

function isBuiltinLogViewerApi(req, requestUrl) {
  if (req.method !== "GET") {
    return false;
  }

  const pathname = requestUrl.pathname;
  return (
    pathname === "/api/logs" ||
    pathname === "/api/logs/days" ||
    pathname.startsWith("/logs-assets/")
  );
}

function isLocalPublicBrowsePath(requestUrl) {
  const pathname = requestUrl.pathname;
  return (
    pathname === "/health" ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  );
}

function isLocalPublicBrowseRequest(req, requestUrl) {
  if (!isLoopbackRequest(req) || req.method !== "GET") {
    return false;
  }
  return isBuiltinLogViewerApi(req, requestUrl) || isLocalPublicBrowsePath(requestUrl);
}

function mimeTypeForDocsPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function authorizeRequest(req, requestUrl) {
  if (!requiredApiKey) {
    return true;
  }

  const authHeader = String(req.headers.authorization || "");
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const fallbackToken = String(req.headers["x-api-key"] || "").trim();
  const queryToken = String(requestUrl?.searchParams.get("api_key") || "").trim();
  const queryKey = String(requestUrl?.searchParams.get("key") || "").trim();

  return (
    bearerToken === requiredApiKey ||
    fallbackToken === requiredApiKey ||
    queryToken === requiredApiKey ||
    queryKey === requiredApiKey
  );
}

function applyCors(req, res) {
  const requestOrigin = String(req.headers.origin || "").trim();
  const resolvedOrigin = requestOrigin || allowOrigin;

  res.setHeader("access-control-allow-origin", resolvedOrigin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    req.headers["access-control-request-headers"] || "Authorization, Content-Type, X-API-Key",
  );
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-private-network", "true");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "Origin, Access-Control-Request-Headers");
}

function logCorsPreflight(req) {
  const origin = String(req.headers.origin || "");
  const method = String(req.headers["access-control-request-method"] || "");
  const headers = String(req.headers["access-control-request-headers"] || "");
  const privateNetwork = String(req.headers["access-control-request-private-network"] || "");
  console.log(
    `[cors] ${new Date().toISOString()} ${req.url || "/"} origin=${origin || "(none)"} method=${method || "(none)"} headers=${headers || "(none)"} privateNetwork=${privateNetwork || "(none)"}`,
  );
}

async function tryReadRequestJson(req, res) {
  try {
    return await readJsonBody(req);
  } catch (error) {
    sendOpenAiError(res, 400, "invalid_request_error", error.message);
    return null;
  }
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    throw new Error("Request body is required.");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function sendOpenAiError(res, statusCode, type, message) {
  return sendJson(res, statusCode, {
    error: {
      message,
      type,
      param: null,
      code: type,
    },
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function sendBinary(res, statusCode, bytes, contentType) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "private, max-age=31536000, immutable",
  });
  res.end(bytes);
}

function makeId(prefix) {
  return `${prefix}_local_${Math.random().toString(36).slice(2, 12)}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
