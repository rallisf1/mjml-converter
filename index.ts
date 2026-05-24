import { JSDOM } from "jsdom";
import { htmlToMjml } from "html-to-mjml";
import { readFileSync } from "node:fs";
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

const defaultNotifuseAiSupportedTypes = [
  "mj-body",
  "mj-button",
  "mj-column",
  "mj-divider",
  "mj-group",
  "mj-image",
  "mj-raw",
  "mj-section",
  "mj-social",
  "mj-social-element",
  "mj-spacer",
  "mj-text",
  "mj-wrapper",
  "mj-head",
  "mj-attributes",
  "mj-breakpoint",
  "mj-font",
  "mj-html-attributes",
  "mj-preview",
  "mj-style",
  "mj-title",
  "mjml",
] as const;

type NotifuseAiSchemaFile = {
  properties?: {
    type?: {
      enum?: unknown;
    };
  };
  allOf?: unknown;
};

type NotifuseAiSchemaRule = {
  if?: {
    properties?: {
      type?: {
        const?: unknown;
      };
    };
  };
  then?: {
    properties?: {
      attributes?: {
        properties?: Record<string, unknown>;
      };
    };
  };
};

function loadNotifuseAiSchemaFile(): NotifuseAiSchemaFile | null {
  try {
    const schemaPath = new URL("./mjml_schema/mjml-components-schema-ai.json", import.meta.url);
    return JSON.parse(readFileSync(schemaPath, "utf8")) as NotifuseAiSchemaFile;
  } catch {
    // Fallback to baked-in defaults when schema file is not available.
    return null;
  }
}

function resolveNotifuseAiSupportedTypes(schema: NotifuseAiSchemaFile | null): Set<string> {
  const componentTypes = schema?.properties?.type?.enum;
  if (Array.isArray(componentTypes) && componentTypes.every((value) => typeof value === "string")) {
    return new Set(componentTypes);
  }

  return new Set(defaultNotifuseAiSupportedTypes);
}

function resolveNotifuseAiAllowedAttributesByType(schema: NotifuseAiSchemaFile | null): Map<string, Set<string>> {
  const allowedByType = new Map<string, Set<string>>();
  const rules = schema?.allOf;
  if (!Array.isArray(rules)) {
    return allowedByType;
  }

  for (const ruleUnknown of rules) {
    const rule = ruleUnknown as NotifuseAiSchemaRule;
    const tagName = rule.if?.properties?.type?.const;
    const attributes = rule.then?.properties?.attributes?.properties;
    if (typeof tagName !== "string" || !attributes || typeof attributes !== "object") {
      continue;
    }

    allowedByType.set(
      tagName,
      new Set(
        Object.keys(attributes).map((key) => toKebabCaseKey(key)),
      ),
    );
  }

  return allowedByType;
}

const notifuseAiSchemaFile = loadNotifuseAiSchemaFile();
const notifuseAiSupportedTypes = resolveNotifuseAiSupportedTypes(notifuseAiSchemaFile);
const notifuseAiAllowedAttributesByType = resolveNotifuseAiAllowedAttributesByType(notifuseAiSchemaFile);
const notifuseAiLeafTypes = new Set([
  "mj-text",
  "mj-button",
  "mj-image",
  "mj-divider",
  "mj-spacer",
  "mj-raw",
  "mj-social-element",
]);
const notifuseAiColumnContentTypes = new Set(["mj-text", "mj-button", "mj-image", "mj-divider", "mj-spacer", "mj-social", "mj-raw"]);
const notifuseAiAllowedChildrenByParent = new Map<string, Set<string>>([
  ["mjml", new Set(["mj-head", "mj-body"])],
  ["mj-body", new Set(["mj-wrapper", "mj-section", "mj-raw"])],
  ["mj-wrapper", new Set(["mj-section", "mj-raw"])],
  ["mj-section", new Set(["mj-column", "mj-group", "mj-raw"])],
  ["mj-group", new Set(["mj-column"])],
  ["mj-column", new Set(["mj-text", "mj-button", "mj-image", "mj-divider", "mj-spacer", "mj-social", "mj-raw"])],
  ["mj-social", new Set(["mj-social-element"])],
  [
    "mj-head",
    new Set(["mj-attributes", "mj-breakpoint", "mj-font", "mj-html-attributes", "mj-preview", "mj-style", "mj-title", "mj-raw"]),
  ],
]);

const outlookConditionalStartPattern = /<!--\s*\[if\s+(?:!?\s*mso\b|(?:lt|lte|gt|gte)\s+mso\b|mso\s*\|\s*ie\b|ie\b)/i;
const conditionalEndPattern = /<!--\s*<!\[endif\]\s*-->/i;
const presentationOnlyAttributeKeys = new Set([
  "style",
  "class",
  "role",
  "lang",
  "dir",
  "align",
  "width",
  "height",
  "border",
  "cellpadding",
  "cellspacing",
  "max-width",
  "maxWidth",
  "margin",
  "padding",
  "font-size",
  "fontSize",
  "vertical-align",
  "verticalAlign",
  "bgcolor",
  "xmlns",
  "xmlns:v",
  "xmlns:o",
  "aria-roledescription",
  "ariaRoledescription",
]);

function isOutlookConditionalRawContent(content: string | undefined): boolean {
  if (!content) {
    return false;
  }

  return outlookConditionalStartPattern.test(content) || conditionalEndPattern.test(content);
}

function hasMeaningfulAttributes(attributes: MjmlAstNode["attributes"]): boolean {
  if (!attributes) {
    return false;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }

    if (!presentationOnlyAttributeKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function shouldPruneEmptyNode(node: MjmlAstNode, normalizedChildren: MjmlAstNode[]): boolean {
  const hasChildren = normalizedChildren.length > 0;
  if (hasChildren) {
    return false;
  }

  const hasContent = (node.content ?? "").trim().length > 0;
  if (hasContent) {
    return false;
  }

  return !hasMeaningfulAttributes(node.attributes);
}

function cleanOutlookRawAndPruneNode(
  node: MjmlAstNode,
  isRoot: boolean,
  parentTagName: string | null,
): MjmlAstNode | null {
  if (node.tagName === "mj-raw" && isOutlookConditionalRawContent(node.content)) {
    return null;
  }

  if (parentTagName === "mj-head" && node.tagName === "mj-text") {
    return null;
  }

  const cleanedChildren = (node.children ?? [])
    .map((child) => cleanOutlookRawAndPruneNode(child, false, node.tagName))
    .filter((child): child is MjmlAstNode => child !== null);

  const normalizedNode: MjmlAstNode = {
    tagName: node.tagName,
    ...(node.attributes ? { attributes: node.attributes } : {}),
    ...(node.content === undefined ? {} : { content: node.content }),
    ...(cleanedChildren.length > 0 ? { children: cleanedChildren } : {}),
  };

  if (!isRoot && shouldPruneEmptyNode(normalizedNode, cleanedChildren)) {
    return null;
  }

  return normalizedNode;
}

function removeOutlookRawAndPrune(ast: MjmlAstNode): MjmlAstNode {
  const cleaned = cleanOutlookRawAndPruneNode(ast, true, null);
  if (!cleaned) {
    return ast;
  }
  return cleaned;
}

function isAllowedNotifuseAiChild(parentTagName: string, childTagName: string): boolean {
  const allowedChildren = notifuseAiAllowedChildrenByParent.get(parentTagName);
  if (!allowedChildren) {
    return true;
  }

  return allowedChildren.has(childTagName);
}

function hasAnyNonEmptyAttribute(attributes?: MjmlAstNode["attributes"]): boolean {
  if (!attributes) {
    return false;
  }

  for (const value of Object.values(attributes)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (String(value).trim() !== "") {
      return true;
    }
  }

  return false;
}

function parsePxValue(value: AttributeValue | undefined): number {
  if (typeof value === "number") {
    return value > 0 ? value : 0;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)px$/i);
  if (!match) {
    return 0;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function formatPxValue(value: number): string {
  return Number.isInteger(value) ? `${value}px` : `${value}px`;
}

function buildCombinedSpacerFromTextAttributes(
  attributes?: MjmlAstNode["attributes"],
): MjmlAstNode | null {
  if (!attributes) {
    return null;
  }

  const paddingTop = parsePxValue(attributes["padding-top"]);
  const paddingBottom = parsePxValue(attributes["padding-bottom"]);
  const total = paddingTop + paddingBottom;
  if (total <= 0) {
    return null;
  }

  return {
    tagName: "mj-spacer",
    attributes: {
      height: formatPxValue(total),
    },
  };
}

function sanitizeAttributesForNotifuseType(
  tagName: string,
  attributes?: MjmlAstNode["attributes"],
): MjmlAstNode["attributes"] | undefined {
  if (!attributes) {
    return undefined;
  }

  const allowedAttributeKeys = notifuseAiAllowedAttributesByType.get(tagName);
  if (!allowedAttributeKeys || allowedAttributeKeys.size === 0) {
    return undefined;
  }

  const sanitized: Record<string, AttributeValue | undefined> = {};
  for (const [rawKey, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }

    const normalizedKey = toKebabCaseKey(rawKey);
    if (!allowedAttributeKeys.has(normalizedKey)) {
      continue;
    }
    sanitized[normalizedKey] = value;
  }

  if (Object.keys(sanitized).length === 0) {
    return undefined;
  }

  return sanitized;
}

function isRedundantNestedTextWrapper(node: MjmlAstNode, normalizedChildren: MjmlAstNode[]): boolean {
  if (node.tagName !== "mj-text") {
    return false;
  }

  if (normalizedChildren.length === 0) {
    return false;
  }

  if ((node.content ?? "").trim().length > 0) {
    return false;
  }

  return !hasAnyNonEmptyAttribute(node.attributes);
}

function normalizeTableAttributesForSection(attributes?: MjmlAstNode["attributes"]): MjmlAstNode["attributes"] | undefined {
  if (!attributes) {
    return undefined;
  }

  const backgroundColor = attributes["background-color"] ?? attributes["backgroundColor"];
  if (backgroundColor === undefined || backgroundColor === null || String(backgroundColor).trim() === "") {
    return undefined;
  }

  return {
    "background-color": backgroundColor,
  };
}

function normalizeTableAttributesForColumn(attributes?: MjmlAstNode["attributes"]): MjmlAstNode["attributes"] | undefined {
  if (!attributes) {
    return undefined;
  }

  const width = attributes.width;
  if (width === undefined || width === null || String(width).trim() === "") {
    return undefined;
  }

  return {
    width,
  };
}

function collectContentNodesForNotifuse(nodes: MjmlAstNode[]): MjmlAstNode[] {
  const contentNodes: MjmlAstNode[] = [];

  const visit = (node: MjmlAstNode): void => {
    const sanitizedAttributes = sanitizeAttributesForNotifuseType(node.tagName, node.attributes);
    const hasOwnContent = (node.content ?? "").trim().length > 0;

    if (node.tagName === "mj-social") {
      const socialChildren = (node.children ?? []).filter((child) => child.tagName === "mj-social-element");
      if (socialChildren.length > 0) {
        contentNodes.push({
          tagName: "mj-social",
          ...(sanitizedAttributes ? { attributes: sanitizedAttributes } : {}),
          children: socialChildren.map((child) => {
            const socialElementAttributes = sanitizeAttributesForNotifuseType("mj-social-element", child.attributes);
            return {
              tagName: "mj-social-element",
              ...(socialElementAttributes ? { attributes: socialElementAttributes } : {}),
              ...(child.content === undefined ? {} : { content: child.content }),
            };
          }),
        });
      }
      return;
    }

    if (notifuseAiColumnContentTypes.has(node.tagName)) {
      const hasOwnAttributes = hasAnyNonEmptyAttribute(sanitizedAttributes);
      const keepAsContentNode = node.tagName === "mj-text" ? hasOwnContent : hasOwnContent || hasOwnAttributes;
      if (keepAsContentNode) {
        contentNodes.push({
          tagName: node.tagName,
          ...(sanitizedAttributes ? { attributes: sanitizedAttributes } : {}),
          ...(node.content === undefined ? {} : { content: node.content }),
        });
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
      return;
    }

    if (hasOwnContent) {
      contentNodes.push({
        tagName: "mj-text",
        content: node.content,
      });
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return contentNodes;
}

function wrapContentNodesForParent(
  parentTagName: string | null,
  contentNodes: MjmlAstNode[],
  sourceAttributes?: MjmlAstNode["attributes"],
): MjmlAstNode[] {
  if (contentNodes.length === 0) {
    return [];
  }

  if (parentTagName === "mj-column") {
    return contentNodes;
  }

  if (parentTagName === "mj-section" || parentTagName === "mj-group") {
    const columnAttributes = normalizeTableAttributesForColumn(sourceAttributes);
    return [
      {
        tagName: "mj-column",
        ...(columnAttributes ? { attributes: columnAttributes } : {}),
        children: contentNodes,
      },
    ];
  }

  if (parentTagName === "mjml") {
    return [
      {
        tagName: "mj-body",
        children: [
          {
            tagName: "mj-section",
            children: [
              {
                tagName: "mj-column",
                children: contentNodes,
              },
            ],
          },
        ],
      },
    ];
  }

  const sectionAttributes = normalizeTableAttributesForSection(sourceAttributes);
  const columnAttributes = normalizeTableAttributesForColumn(sourceAttributes);

  return [
    {
      tagName: "mj-section",
      ...(sectionAttributes ? { attributes: sectionAttributes } : {}),
      children: [
        {
          tagName: "mj-column",
          ...(columnAttributes ? { attributes: columnAttributes } : {}),
          children: contentNodes,
        },
      ],
    },
  ];
}

function rewriteUnsupportedNodeToSupportedLayout(
  node: MjmlAstNode,
  normalizedChildren: MjmlAstNode[],
  parentTagName: string | null,
): MjmlAstNode[] {
  const contentNodes = collectContentNodesForNotifuse(normalizedChildren);
  const ownContent = (node.content ?? "").trim();
  if (ownContent.length > 0) {
    contentNodes.unshift({
      tagName: "mj-text",
      content: node.content,
    });
  }

  return wrapContentNodesForParent(parentTagName, contentNodes, node.attributes);
}

function normalizeLeafNodeChildrenForParent(
  node: MjmlAstNode,
  normalizedChildren: MjmlAstNode[],
  parentTagName: string | null,
): MjmlAstNode[] {
  if (normalizedChildren.length === 0) {
    return [];
  }

  const contentNodes = collectContentNodesForNotifuse(normalizedChildren);
  return wrapContentNodesForParent(parentTagName, contentNodes, node.attributes);
}

function normalizeAstNodeForNotifuseHtmlImport(
  node: MjmlAstNode,
  parentTagName: string | null,
  isRoot: boolean,
): MjmlAstNode[] {
  const normalizedChildren = (node.children ?? []).flatMap((child) =>
    normalizeAstNodeForNotifuseHtmlImport(child, node.tagName, false),
  );

  if (isRedundantNestedTextWrapper(node, normalizedChildren)) {
    return normalizedChildren;
  }

  const sanitizedAttributes = sanitizeAttributesForNotifuseType(node.tagName, node.attributes);
  const normalizedNode: MjmlAstNode = {
    tagName: node.tagName,
    ...(sanitizedAttributes ? { attributes: sanitizedAttributes } : {}),
    ...(node.content === undefined ? {} : { content: node.content }),
  };

  const isSupportedType = notifuseAiSupportedTypes.has(node.tagName);
  const isAllowedByParent = parentTagName === null ? true : isAllowedNotifuseAiChild(parentTagName, node.tagName);
  if (!isSupportedType || !isAllowedByParent) {
    return rewriteUnsupportedNodeToSupportedLayout(node, normalizedChildren, parentTagName);
  }

  if (notifuseAiLeafTypes.has(node.tagName)) {
    const relocatedChildren = normalizeLeafNodeChildrenForParent(node, normalizedChildren, parentTagName);
    if (node.tagName === "mj-text" && (node.content ?? "").trim().length === 0) {
      const spacerNode = buildCombinedSpacerFromTextAttributes(sanitizedAttributes);
      return [...(spacerNode ? [spacerNode] : []), ...relocatedChildren];
    }

    const keepLeafNode =
      (node.content ?? "").trim().length > 0 || hasAnyNonEmptyAttribute(sanitizedAttributes);
    if (!keepLeafNode) {
      return relocatedChildren;
    }

    return [normalizedNode, ...relocatedChildren];
  }

  const mergedNode: MjmlAstNode = {
    ...normalizedNode,
    ...(normalizedChildren.length > 0 ? { children: normalizedChildren } : {}),
  };

  if (!isRoot && shouldPruneEmptyNode(mergedNode, normalizedChildren)) {
    return [];
  }

  return [mergedNode];
}

function normalizeHtmlImportAstForNotifuseCompatibility(ast: MjmlAstNode): MjmlAstNode {
  const normalized = normalizeAstNodeForNotifuseHtmlImport(ast, null, true);
  const root = normalized[0];
  if (!root || root.tagName !== "mjml") {
    throw new ApiError(400, "BAD_INPUT", "HTML conversion did not produce a valid MJML root.");
  }

  return root;
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

function ensureHtmlToMjmlRuntimeGlobals(): void {
  const globalWithNode = globalThis as { Node?: unknown };
  if (globalWithNode.Node !== undefined) {
    return;
  }

  // html-to-mjml expects global Node constants in server runtimes.
  globalWithNode.Node = new JSDOM("").window.Node;
}

function htmlToMjmlXml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) {
    throw new ApiError(400, "BAD_INPUT", "HTML body must not be empty.");
  }

  ensureHtmlToMjmlRuntimeGlobals();

  try {
    return htmlToMjml(trimmed, {
      validateOutput: false,
      inlineStyles: true,
      wrapContent: true,
      showWarnings: true,
      preserveClassNames: false,
    });
  } catch {
    throw new ApiError(400, "BAD_INPUT", "HTML to MJML conversion failed.");
  }
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
  const cleanedAst = removeOutlookRawAndPrune(parseMjmlXml(mjmlXml));
  const ast = normalizeHtmlImportAstForNotifuseCompatibility(cleanedAst);

  if (accept === "application/xml") {
    return textResponse(mjmlAstToXml(ast), "application/xml");
  }

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
