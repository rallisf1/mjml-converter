import mjml2html from "mjml";
import mjmlParserLib from "mjml-parser-xml";
import { z } from "zod";

type MediaType = "application/json" | "application/xml" | "text/html";
type AttributeValue = string | boolean | number | null;

type ErrorCode =
  | "BAD_INPUT"
  | "FORBIDDEN"
  | "NOT_ACCEPTABLE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "INTERNAL_ERROR";

interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface MjmlAstNode {
  tagName: string;
  attributes?: Record<string, AttributeValue | undefined>;
  content?: string;
  children?: MjmlAstNode[];
}

export interface NotifuseMjmlNode {
  id: string;
  type: string;
  attributes?: Record<string, AttributeValue>;
  content?: string;
  children?: NotifuseMjmlNode[];
}

interface MjmlToHtmlResult {
  html: string;
  warnings: unknown[];
}

export interface ApiConfig {
  apiKey: string;
}

export interface ServerConfig extends ApiConfig {
  port?: number;
}

const mjmlParser = mjmlParserLib as unknown as (
  xml: string,
  options?: Record<string, unknown>,
) => MjmlAstNode;

const attributeValueSchema = z.union([z.string(), z.boolean(), z.number(), z.null()]);

const legacyAstSchema: z.ZodType<MjmlAstNode> = z.lazy(() =>
  z
    .object({
      tagName: z.string().min(1),
      attributes: z.record(z.string(), attributeValueSchema).optional(),
      content: z.string().optional(),
      children: z.array(legacyAstSchema).optional(),
    })
    .passthrough(),
);

const notifuseNodeSchema: z.ZodType<NotifuseMjmlNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      type: z.string().min(1),
      attributes: z.record(z.string(), attributeValueSchema).optional(),
      content: z.string().optional(),
      children: z.array(notifuseNodeSchema).optional(),
    })
    .passthrough(),
);

class ApiError extends Error {
  status: number;
  code: ErrorCode;
  details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorResponse(status: number, code: ErrorCode, message: string, details?: unknown): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };

  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parseMediaType(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }

  const first = headerValue.split(",")[0];
  if (!first) {
    return null;
  }

  const base = first.split(";")[0]?.trim().toLowerCase();
  return base || null;
}

function parseAcceptHeader(headerValue: string | null): string[] {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase())
    .filter((part): part is string => Boolean(part));
}

function requireBearerApiKey(request: Request, expectedApiKey: string): void {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new ApiError(403, "FORBIDDEN", "Missing Authorization header.");
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    throw new ApiError(403, "FORBIDDEN", "Authorization must use Bearer token format.");
  }

  if (token !== expectedApiKey) {
    throw new ApiError(403, "FORBIDDEN", "Invalid API key.");
  }
}

function negotiateAccept(request: Request, supported: MediaType[]): MediaType {
  const acceptRaw = request.headers.get("accept");
  if (!acceptRaw) {
    throw new ApiError(406, "NOT_ACCEPTABLE", "Missing Accept header.");
  }

  const acceptedMediaTypes = parseAcceptHeader(acceptRaw);
  if (acceptedMediaTypes.length === 0) {
    throw new ApiError(406, "NOT_ACCEPTABLE", "Accept header is empty.");
  }

  for (const mediaType of acceptedMediaTypes) {
    if (supported.includes(mediaType as MediaType)) {
      return mediaType as MediaType;
    }
  }

  throw new ApiError(406, "NOT_ACCEPTABLE", "Requested Accept type is not supported.", {
    supported,
  });
}

function requireContentType(request: Request, supported: MediaType[]): MediaType {
  const contentType = parseMediaType(request.headers.get("content-type"));
  if (!contentType) {
    throw new ApiError(415, "UNSUPPORTED_CONTENT_TYPE", "Missing Content-Type header.");
  }

  if (!supported.includes(contentType as MediaType)) {
    throw new ApiError(415, "UNSUPPORTED_CONTENT_TYPE", "Unsupported Content-Type.", {
      supported,
    });
  }

  return contentType as MediaType;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toKebabCaseKey(key: string): string {
  return key
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function toCamelCaseKey(key: string): string {
  return key
    .replace(/_/g, "-")
    .replace(/-([a-zA-Z0-9])/g, (_, part: string) => part.toUpperCase());
}

function normalizeAttributesToKebab(
  attributes?: Record<string, AttributeValue | undefined>,
): Record<string, AttributeValue | undefined> | undefined {
  if (!attributes) {
    return undefined;
  }

  const normalized: Record<string, AttributeValue | undefined> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    normalized[toKebabCaseKey(key)] = value;
  }

  return normalized;
}

function normalizeAttributesToCamel(
  attributes?: Record<string, AttributeValue | undefined>,
): Record<string, AttributeValue> | undefined {
  if (!attributes) {
    return undefined;
  }

  const normalized: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    normalized[toCamelCaseKey(key)] = value;
  }

  return normalized;
}

function assertNoMixedJsonSchemaNodes(node: unknown, path = "$."): void {
  if (!isPlainObject(node)) {
    return;
  }

  const hasLegacyKey = hasOwnProperty(node, "tagName");
  const hasNotifuseKey = hasOwnProperty(node, "id") || hasOwnProperty(node, "type");
  if (hasLegacyKey && hasNotifuseKey) {
    throw new ApiError(
      400,
      "BAD_INPUT",
      "Ambiguous MJML JSON schema: cannot mix legacy 'tagName' with Notifuse 'id'/'type'.",
      { path },
    );
  }

  const children = node.children;
  if (!Array.isArray(children)) {
    return;
  }

  for (let i = 0; i < children.length; i += 1) {
    assertNoMixedJsonSchemaNodes(children[i], `${path}children[${i}].`);
  }
}

function normalizeLegacyAst(ast: MjmlAstNode): MjmlAstNode {
  return {
    tagName: ast.tagName,
    ...(ast.content === undefined ? {} : { content: ast.content }),
    ...(ast.attributes ? { attributes: normalizeAttributesToKebab(ast.attributes) } : {}),
    ...(ast.children ? { children: ast.children.map(normalizeLegacyAst) } : {}),
  };
}

function notifuseNodeToInternalAst(node: NotifuseMjmlNode): MjmlAstNode {
  const normalizedAttributes = normalizeAttributesToKebab(node.attributes);
  if (node.type === "mj-preview" && normalizedAttributes) {
    delete normalizedAttributes.content;
  }

  return {
    tagName: node.type,
    ...(node.content === undefined ? {} : { content: node.content }),
    ...(normalizedAttributes ? { attributes: normalizedAttributes } : {}),
    ...(node.children ? { children: node.children.map(notifuseNodeToInternalAst) } : {}),
  };
}

function internalAstToNotifuseNode(
  node: MjmlAstNode,
  perTagCounters: Map<string, number>,
): NotifuseMjmlNode {
  const currentCount = (perTagCounters.get(node.tagName) ?? 0) + 1;
  perTagCounters.set(node.tagName, currentCount);

  return {
    id: `${node.tagName}-${currentCount}`,
    type: node.tagName,
    ...(node.attributes ? { attributes: normalizeAttributesToCamel(node.attributes) } : {}),
    ...(node.content === undefined ? {} : { content: node.content }),
    ...(node.children ? { children: node.children.map((child) => internalAstToNotifuseNode(child, perTagCounters)) } : {}),
  };
}

function mjmlAstToNotifuseJson(ast: MjmlAstNode): NotifuseMjmlNode {
  return internalAstToNotifuseNode(ast, new Map<string, number>());
}

async function readTextBody(request: Request): Promise<string> {
  const body = await request.text();
  if (!body.trim()) {
    throw new ApiError(400, "BAD_INPUT", "Request body must not be empty.");
  }
  return body;
}

async function readMjmlJsonBodyAsAst(request: Request): Promise<MjmlAstNode> {
  let parsedJson: unknown;

  try {
    parsedJson = await request.json();
  } catch {
    throw new ApiError(400, "BAD_INPUT", "Malformed JSON body.");
  }

  if (!isPlainObject(parsedJson)) {
    throw new ApiError(400, "BAD_INPUT", "JSON body must be an object.");
  }

  assertNoMixedJsonSchemaNodes(parsedJson);

  const hasLegacyRoot = hasOwnProperty(parsedJson, "tagName");
  const hasNotifuseRoot = hasOwnProperty(parsedJson, "id") || hasOwnProperty(parsedJson, "type");

  if (hasLegacyRoot) {
    const parsedLegacy = legacyAstSchema.safeParse(parsedJson);
    if (!parsedLegacy.success) {
      throw new ApiError(400, "BAD_INPUT", "JSON body is not a valid legacy MJML AST.", parsedLegacy.error.issues);
    }

    const normalizedLegacy = normalizeLegacyAst(parsedLegacy.data);
    if (normalizedLegacy.tagName !== "mjml") {
      throw new ApiError(400, "BAD_INPUT", "MJML AST root node must be 'mjml'.");
    }

    return normalizedLegacy;
  }

  if (hasNotifuseRoot) {
    const parsedNotifuse = notifuseNodeSchema.safeParse(parsedJson);
    if (!parsedNotifuse.success) {
      throw new ApiError(400, "BAD_INPUT", "JSON body is not a valid Notifuse MJML schema.", parsedNotifuse.error.issues);
    }

    if (parsedNotifuse.data.type !== "mjml") {
      throw new ApiError(400, "BAD_INPUT", "Notifuse MJML root node type must be 'mjml'.");
    }

    return notifuseNodeToInternalAst(parsedNotifuse.data);
  }

  throw new ApiError(
    400,
    "BAD_INPUT",
    "JSON body must use either legacy 'tagName' schema or Notifuse 'id'/'type' schema.",
  );
}

function parseMjmlXml(xml: string): MjmlAstNode {
  try {
    const ast = mjmlParser(xml, { ignoreIncludes: true });

    if (ast.tagName !== "mjml") {
      throw new ApiError(400, "BAD_INPUT", "MJML XML root node must be 'mjml'.");
    }

    return ast;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(400, "BAD_INPUT", "Malformed MJML XML payload.");
  }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeAttributes(attributes?: MjmlAstNode["attributes"]): string {
  if (!attributes) {
    return "";
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    const scalar = value === null ? "" : String(value);
    parts.push(`${key}="${escapeXmlAttribute(scalar)}"`);
  }

  return parts.length ? ` ${parts.join(" ")}` : "";
}

function renderMjmlNode(node: MjmlAstNode): string {
  const attrs = serializeAttributes(node.attributes);
  const content = node.content ?? "";
  const children = (node.children ?? []).map(renderMjmlNode).join("");

  if (!content && !children) {
    return `<${node.tagName}${attrs} />`;
  }

  return `<${node.tagName}${attrs}>${content}${children}</${node.tagName}>`;
}

function mjmlAstToXml(ast: MjmlAstNode): string {
  if (ast.tagName !== "mjml") {
    throw new ApiError(400, "BAD_INPUT", "MJML AST root node must be 'mjml'.");
  }

  return renderMjmlNode(ast);
}

function htmlToMjmlXml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) {
    throw new ApiError(400, "BAD_INPUT", "HTML body must not be empty.");
  }

  if (trimmed.toLowerCase().includes("</mj-raw>")) {
    throw new ApiError(400, "BAD_INPUT", "HTML body cannot contain '</mj-raw>'.");
  }

  return [
    "<mjml>",
    "  <mj-body>",
    "    <mj-section>",
    "      <mj-column>",
    `        <mj-raw>${trimmed}</mj-raw>`,
    "      </mj-column>",
    "    </mj-section>",
    "  </mj-body>",
    "</mjml>",
  ].join("\n");
}

async function mjmlToHtml(input: { xml?: string; ast?: MjmlAstNode }): Promise<MjmlToHtmlResult> {
  const xml = input.xml ?? (input.ast ? mjmlAstToXml(input.ast) : undefined);
  if (!xml) {
    throw new ApiError(400, "BAD_INPUT", "MJML input is missing.");
  }

  let result: Awaited<ReturnType<typeof mjml2html>>;
  try {
    result = await mjml2html(xml, { validationLevel: "strict" });
  } catch (error) {
    const maybeValidationErrors =
      typeof error === "object" && error !== null && "errors" in error
        ? (error as { errors?: unknown[] }).errors
        : undefined;
    if (Array.isArray(maybeValidationErrors) && maybeValidationErrors.length > 0) {
      throw new ApiError(400, "BAD_INPUT", "MJML validation failed.", maybeValidationErrors);
    }

    throw new ApiError(400, "BAD_INPUT", "Malformed MJML XML payload.");
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new ApiError(400, "BAD_INPUT", "MJML validation failed.", result.errors);
  }

  return {
    html: result.html,
    warnings: result.errors ?? [],
  };
}

function textResponse(body: string, mediaType: MediaType): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": `${mediaType}; charset=utf-8`,
    },
  });
}

async function handleHtmlToMjml(request: Request): Promise<Response> {
  requireContentType(request, ["text/html"]);
  const accept = negotiateAccept(request, ["application/xml", "application/json"]);

  const html = await readTextBody(request);
  const mjmlXml = htmlToMjmlXml(html);

  if (accept === "application/xml") {
    return textResponse(mjmlXml, "application/xml");
  }

  const ast = parseMjmlXml(mjmlXml);
  return Response.json(mjmlAstToNotifuseJson(ast), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function handleMjmlToHtml(request: Request): Promise<Response> {
  const contentType = requireContentType(request, ["application/xml", "application/json"]);
  const accept = negotiateAccept(request, ["text/html", "application/json"]);

  if (contentType === "application/xml") {
    const xml = await readTextBody(request);
    parseMjmlXml(xml);

    const output = await mjmlToHtml({ xml });
    if (accept === "text/html") {
      return textResponse(output.html, "text/html");
    }

    return Response.json(output, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  const ast = await readMjmlJsonBodyAsAst(request);
  const output = await mjmlToHtml({ ast });

  if (accept === "text/html") {
    return textResponse(output.html, "text/html");
  }

  return Response.json(output, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function handleMjmlToMjml(request: Request): Promise<Response> {
  const contentType = requireContentType(request, ["application/xml", "application/json"]);
  const accept = negotiateAccept(request, ["application/xml", "application/json"]);

  if (contentType === accept) {
    throw new ApiError(
      400,
      "BAD_INPUT",
      "No conversion requested: Content-Type and Accept must differ for /mjml-to-mjml.",
    );
  }

  const ast =
    contentType === "application/xml"
      ? parseMjmlXml(await readTextBody(request))
      : await readMjmlJsonBodyAsAst(request);

  if (accept === "application/json") {
    return Response.json(mjmlAstToNotifuseJson(ast), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    });
  }

  const xml = mjmlAstToXml(ast);
  return textResponse(xml, "application/xml");
}

function requireApiKey(config: ApiConfig): string {
  if (!config.apiKey || !config.apiKey.trim()) {
    throw new Error("Missing required API key in config.");
  }

  return config.apiKey;
}

export function createApiFetchHandler(config: ApiConfig): (request: Request) => Promise<Response> {
  const expectedApiKey = requireApiKey(config);

  return async function fetchHandler(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        if (request.method !== "GET") {
          return errorResponse(405, "BAD_INPUT", "Method not allowed. Use GET.");
        }

        return Response.json(
          {
            status: "ok",
          },
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          },
        );
      }

      requireBearerApiKey(request, expectedApiKey);

      if (request.method !== "POST") {
        if (
          url.pathname === "/html-to-mjml" ||
          url.pathname === "/mjml-to-html" ||
          url.pathname === "/mjml-to-mjml"
        ) {
          return errorResponse(405, "BAD_INPUT", "Method not allowed. Use POST.");
        }

        return errorResponse(404, "BAD_INPUT", "Route not found.");
      }

      if (url.pathname === "/html-to-mjml") {
        return await handleHtmlToMjml(request);
      }

      if (url.pathname === "/mjml-to-html") {
        return await handleMjmlToHtml(request);
      }

      if (url.pathname === "/mjml-to-mjml") {
        return await handleMjmlToMjml(request);
      }

      return errorResponse(404, "BAD_INPUT", "Route not found.");
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResponse(error.status, error.code, error.message, error.details);
      }

      console.error(error);
      return errorResponse(500, "INTERNAL_ERROR", "Internal server error.");
    }
  };
}

export function createServer(config: ServerConfig): Bun.Server<unknown> {
  const fetchHandler = createApiFetchHandler(config);

  return Bun.serve({
    port: config.port ?? 3000,
    fetch: fetchHandler,
  });
}

function resolveServerConfigFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: API_KEY");
  }

  return {
    apiKey,
    port: Number(env.PORT ?? 3000),
  };
}

if (import.meta.main) {
  const server = createServer(resolveServerConfigFromEnv(Bun.env));
  console.log(`MJML converter API listening on port ${server.port}`);
}
