import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { createApiFetchHandler, type MjmlAstNode, type NotifuseMjmlNode } from "./index";

const API_KEY = "test-key";
const handler = createApiFetchHandler({ apiKey: API_KEY });

const notifuseSamplePath = new URL("./mjml-sample.json", import.meta.url);
const notifuseSample = (
  existsSync(notifuseSamplePath)
    ? JSON.parse(readFileSync(notifuseSamplePath, "utf8"))
    : {
        id: "mjml-1",
        type: "mjml",
        children: [
          {
            id: "mj-body-1",
            type: "mj-body",
            children: [
              {
                id: "mj-section-1",
                type: "mj-section",
                children: [
                  {
                    id: "mj-column-1",
                    type: "mj-column",
                    children: [
                      {
                        id: "mj-text-1",
                        type: "mj-text",
                        content: "Fallback Notifuse sample",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }
) as NotifuseMjmlNode;

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeRequest(path: string, options: RequestOptions = {}): Request {
  const method = options.method ?? "POST";

  return new Request(`http://localhost${path}`, {
    method,
    headers: options.headers,
    body: options.body,
  });
}

async function hit(path: string, options: RequestOptions = {}): Promise<Response> {
  return handler(makeRequest(path, options));
}

async function readErrorCode(response: Response): Promise<string> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code ?? "";
}

function findFirstType(node: NotifuseMjmlNode, type: string): NotifuseMjmlNode | null {
  if (node.type === type) {
    return node;
  }

  for (const child of node.children ?? []) {
    const found = findFirstType(child, type);
    if (found) {
      return found;
    }
  }

  return null;
}

function collectRawContents(node: NotifuseMjmlNode, contents: string[] = []): string[] {
  if (node.type === "mj-raw" && typeof node.content === "string") {
    contents.push(node.content);
  }

  for (const child of node.children ?? []) {
    collectRawContents(child, contents);
  }

  return contents;
}

function collectEmptyTextNodes(node: NotifuseMjmlNode, matches: NotifuseMjmlNode[] = []): NotifuseMjmlNode[] {
  if (node.type === "mj-text" && (node.content ?? "").trim().length === 0) {
    matches.push(node);
  }

  for (const child of node.children ?? []) {
    collectEmptyTextNodes(child, matches);
  }

  return matches;
}

function collectSpacerHeights(node: NotifuseMjmlNode, heights: string[] = []): string[] {
  if (node.type === "mj-spacer") {
    const height = node.attributes?.height;
    if (typeof height === "string") {
      heights.push(height);
    }
  }

  for (const child of node.children ?? []) {
    collectSpacerHeights(child, heights);
  }

  return heights;
}

function collectHeadTextNodes(node: NotifuseMjmlNode, inHead = false, nodes: NotifuseMjmlNode[] = []): NotifuseMjmlNode[] {
  const currentlyInHead = inHead || node.type === "mj-head";
  if (currentlyInHead && node.type === "mj-text") {
    nodes.push(node);
  }

  for (const child of node.children ?? []) {
    collectHeadTextNodes(child, currentlyInHead, nodes);
  }

  return nodes;
}

function hasOutlookConditionalSnippet(value: string): boolean {
  return /if\s+(?:!?\s*mso|(?:lt|lte|gt|gte)\s+mso|mso\s*\|\s*ie|ie)|<!\[endif\]/i.test(value);
}

const validMjmlXml =
  "<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>";

const validMjmlAst: MjmlAstNode = {
  tagName: "mjml",
  children: [
    {
      tagName: "mj-body",
      children: [
        {
          tagName: "mj-section",
          children: [
            {
              tagName: "mj-column",
              children: [{ tagName: "mj-text", content: "Hello" }],
            },
          ],
        },
      ],
    },
  ],
};

const validNotifuseJson: NotifuseMjmlNode = {
  id: "mjml-1",
  type: "mjml",
  children: [
    {
      id: "mj-body-1",
      type: "mj-body",
      children: [
        {
          id: "mj-section-1",
          type: "mj-section",
          children: [
            {
              id: "mj-column-1",
              type: "mj-column",
              children: [
                {
                  id: "mj-text-1",
                  type: "mj-text",
                  attributes: {
                    paddingTop: "12px",
                  },
                  content: "Hello",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const notifuseAiSchemaPath = new URL("./mjml_schema/mjml-components-schema-ai.json", import.meta.url);
const notifuseAiSupportedTypes = (() => {
  const parsed = JSON.parse(readFileSync(notifuseAiSchemaPath, "utf8")) as {
    properties?: { type?: { enum?: unknown } };
  };
  const componentTypes = parsed.properties?.type?.enum;
  if (!Array.isArray(componentTypes)) {
    return new Set<string>();
  }

  return new Set(componentTypes.filter((value): value is string => typeof value === "string"));
})();
const notifuseAiAllowedAttributesByType = (() => {
  const parsed = JSON.parse(readFileSync(notifuseAiSchemaPath, "utf8")) as {
    allOf?: Array<{
      if?: { properties?: { type?: { const?: unknown } } };
      then?: { properties?: { attributes?: { properties?: Record<string, unknown> } } };
    }>;
  };

  const map = new Map<string, Set<string>>();
  for (const rule of parsed.allOf ?? []) {
    const tagName = rule.if?.properties?.type?.const;
    const attributeObject = rule.then?.properties?.attributes?.properties;
    if (typeof tagName !== "string" || !attributeObject || typeof attributeObject !== "object") {
      continue;
    }

    map.set(tagName, new Set(Object.keys(attributeObject)));
  }

  return map;
})();
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
const notifuseAiLeafTypes = new Set(["mj-text", "mj-button", "mj-image", "mj-divider", "mj-spacer", "mj-raw", "mj-social-element"]);
const sampleHtmlPath = new URL("./sample-input.html", import.meta.url);
const sampleHtml = existsSync(sampleHtmlPath) ? readFileSync(sampleHtmlPath, "utf8") : null;

function collectTypes(node: NotifuseMjmlNode, acc: Set<string> = new Set<string>()): Set<string> {
  acc.add(node.type);
  for (const child of node.children ?? []) {
    collectTypes(child, acc);
  }
  return acc;
}

function assertTreeUsesNotifuseAiSupportedTypes(node: NotifuseMjmlNode): void {
  const seenTypes = collectTypes(node);
  for (const type of seenTypes) {
    expect(notifuseAiSupportedTypes.has(type)).toBe(true);
  }
}

function assertTreeUsesAllowedChildren(node: NotifuseMjmlNode): void {
  for (const child of node.children ?? []) {
    const allowed = notifuseAiAllowedChildrenByParent.get(node.type);
    if (allowed) {
      expect(allowed.has(child.type)).toBe(true);
    }
    assertTreeUsesAllowedChildren(child);
  }
}

function assertLeafTypesDoNotContainMjmlChildren(node: NotifuseMjmlNode): void {
  if (notifuseAiLeafTypes.has(node.type)) {
    expect((node.children ?? []).length).toBe(0);
  }

  for (const child of node.children ?? []) {
    assertLeafTypesDoNotContainMjmlChildren(child);
  }
}

function toKebabCaseKey(key: string): string {
  return key
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function assertAttributesComplyWithAiSchema(node: NotifuseMjmlNode): void {
  const allowed = notifuseAiAllowedAttributesByType.get(node.type) ?? new Set<string>();
  for (const key of Object.keys(node.attributes ?? {})) {
    expect(allowed.has(toKebabCaseKey(key))).toBe(true);
  }

  for (const child of node.children ?? []) {
    assertAttributesComplyWithAiSchema(child);
  }
}

function assertNotifuseAiCompatibility(node: NotifuseMjmlNode): void {
  assertTreeUsesNotifuseAiSupportedTypes(node);
  assertTreeUsesAllowedChildren(node);
  assertLeafTypesDoNotContainMjmlChildren(node);
  assertAttributesComplyWithAiSchema(node);
}

describe("auth", () => {
  test("returns 403 when Authorization header is missing", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: "<div>Hello</div>",
    });

    expect(response.status).toBe(403);
    expect(await readErrorCode(response)).toBe("FORBIDDEN");
  });

  test("returns 403 for bad API key", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: "<div>Hello</div>",
    });

    expect(response.status).toBe(403);
    expect(await readErrorCode(response)).toBe("FORBIDDEN");
  });
});

describe("health", () => {
  test("returns 200 without authentication", async () => {
    const response = await hit("/health", { method: "GET" });
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(body.status).toBe("ok");
  });

  test("returns 405 for non-GET methods", async () => {
    const response = await hit("/health", { method: "POST" });

    expect(response.status).toBe(405);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });
});

describe("header validation", () => {
  test("returns 406 when Accept is missing", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
      },
      body: "<div>Hello</div>",
    });

    expect(response.status).toBe(406);
    expect(await readErrorCode(response)).toBe("NOT_ACCEPTABLE");
  });

  test("returns 406 for unsupported Accept", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "text/plain",
      },
      body: "<div>Hello</div>",
    });

    expect(response.status).toBe(406);
    expect(await readErrorCode(response)).toBe("NOT_ACCEPTABLE");
  });

  test("returns 415 when Content-Type is missing", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        accept: "text/html",
      },
      body: validMjmlXml,
    });

    expect(response.status).toBe(415);
    expect(await readErrorCode(response)).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  test("returns 415 for unsupported Content-Type", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/plain",
        accept: "text/html",
      },
      body: validMjmlXml,
    });

    expect(response.status).toBe(415);
    expect(await readErrorCode(response)).toBe("UNSUPPORTED_CONTENT_TYPE");
  });
});

describe("input validation", () => {
  test("returns 400 for malformed MJML XML", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "text/html",
      },
      body: "<mjml>",
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 for malformed JSON body", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "text/html",
      },
      body: "{ invalid-json",
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 for HTML input that does not convert to a valid MJML root", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: "<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>",
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 for invalid legacy MJML AST shape", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/xml",
      },
      body: JSON.stringify({ tagName: "not-mjml" }),
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 for invalid Notifuse JSON (missing id)", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "text/html",
      },
      body: JSON.stringify({
        type: "mjml",
        children: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 for mixed legacy+Notifuse JSON schema", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "text/html",
      },
      body: JSON.stringify({
        tagName: "mjml",
        id: "mjml-1",
        type: "mjml",
      }),
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 when /mjml-to-mjml uses XML for both Content-Type and Accept", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "application/xml",
      },
      body: validMjmlXml,
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });

  test("returns 400 when /mjml-to-mjml uses JSON for both Content-Type and Accept", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(validMjmlAst),
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("BAD_INPUT");
  });
});

describe("success paths", () => {
  test("html-to-mjml returns XML when Accept is application/xml", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: "<div>Hello</div>",
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/xml")).toBe(true);
    expect(body).toContain("<mjml");
    expect(body).toContain("mj-section");
    expect(body).toContain("Hello");
    expect(body).not.toContain("<mj-raw>");
    expect(body).not.toContain("X-UA-Compatible");
    expect(body).not.toContain("Content-Type");
    expect(body).not.toContain("viewport");
    expect(hasOutlookConditionalSnippet(body)).toBe(false);
  });

  test("html-to-mjml returns Notifuse JSON when Accept is application/json", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/json",
      },
      body: "<div>Hello</div>",
    });

    const body = (await response.json()) as NotifuseMjmlNode;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(body.type).toBe("mjml");
    expect(body.id).toBe("mjml-1");
    expect((body as unknown as { tagName?: string }).tagName).toBeUndefined();

    const bodyNode = findFirstType(body, "mj-body");
    const sectionNode = findFirstType(body, "mj-section");
    const textNode = findFirstType(body, "mj-text");
    const rawContents = collectRawContents(body);
    const headTextNodes = collectHeadTextNodes(body);
    expect(bodyNode?.id).toBe("mj-body-1");
    expect(sectionNode?.id).toBe("mj-section-1");
    expect(textNode !== null || (sectionNode?.content ?? "").includes("Hello")).toBe(true);
    expect(headTextNodes).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain("\"httpEquiv\"");
    expect(JSON.stringify(body)).not.toContain("\"viewport\"");
    expect(rawContents.some(hasOutlookConditionalSnippet)).toBe(false);
    assertNotifuseAiCompatibility(body);
  });

  test("html-to-mjml rewrites table HTML into supported section/column blocks", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/json",
      },
      body: "<table role=\"presentation\" width=\"100%\"><tr><td><h1>Hello</h1><p>World</p></td></tr></table>",
    });

    const body = (await response.json()) as NotifuseMjmlNode;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(findFirstType(body, "mj-table")).toBeNull();
    expect(findFirstType(body, "mj-section")).not.toBeNull();
    expect(findFirstType(body, "mj-column")).not.toBeNull();
    expect(serialized).toContain("Hello");
    expect(serialized).toContain("World");
    assertNotifuseAiCompatibility(body);
  });

  test("html-to-mjml XML output for table HTML does not contain mj-table", async () => {
    const response = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: "<table role=\"presentation\" width=\"100%\"><tr><td><h1>Hello</h1><p>World</p></td></tr></table>",
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("<mj-table");
    expect(body).toContain("<mj-section");
    expect(body).toContain("<mj-column");
    expect(body).toContain("Hello");
    expect(body).toContain("World");
  });

  test("html-to-mjml strips Outlook raw blocks from converted email HTML", async () => {
    const htmlResponse = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "text/html",
      },
      body: validMjmlXml,
    });
    const renderedHtml = await htmlResponse.text();

    const xmlResponse = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: renderedHtml,
    });
    const cleanedXml = await xmlResponse.text();

    const jsonResponse = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/json",
      },
      body: renderedHtml,
    });
    const cleanedJson = (await jsonResponse.json()) as NotifuseMjmlNode;

    expect(xmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(cleanedXml).not.toContain("X-UA-Compatible");
    expect(cleanedXml).not.toContain("Content-Type");
    expect(cleanedXml).not.toContain("viewport");
    expect(hasOutlookConditionalSnippet(cleanedXml)).toBe(false);
    expect(collectHeadTextNodes(cleanedJson)).toHaveLength(0);
    expect(collectRawContents(cleanedJson).some(hasOutlookConditionalSnippet)).toBe(false);
    assertNotifuseAiCompatibility(cleanedJson);
  });

  test("html-to-mjml fixture output is structurally valid for Notifuse AI schema", async () => {
    if (!sampleHtml) {
      return;
    }

    const jsonResponse = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/json",
      },
      body: sampleHtml,
    });
    const xmlResponse = await hit("/html-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "text/html",
        accept: "application/xml",
      },
      body: sampleHtml,
    });

    const jsonBody = (await jsonResponse.json()) as NotifuseMjmlNode;
    const xmlBody = await xmlResponse.text();

    expect(jsonResponse.status).toBe(200);
    expect(xmlResponse.status).toBe(200);
    assertNotifuseAiCompatibility(jsonBody);
    expect(xmlBody).not.toContain("<mj-table");
    expect(collectEmptyTextNodes(jsonBody)).toHaveLength(0);
    expect(xmlBody).not.toMatch(/<mj-text\b[^>]*\/>/i);
    const spacerHeights = collectSpacerHeights(jsonBody);
    expect(spacerHeights.length).toBeGreaterThan(0);
    expect(spacerHeights.some((height) => height === "20px" || height === "40px")).toBe(true);
  });

  test("mjml-to-html accepts XML input and returns HTML", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "text/html",
      },
      body: validMjmlXml,
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("text/html")).toBe(true);
    expect(body).toContain("<!doctype html>");
  });

  test("mjml-to-html accepts legacy AST JSON and returns JSON envelope", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(validMjmlAst),
    });

    const body = (await response.json()) as { html: string; warnings: unknown[] };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(typeof body.html).toBe("string");
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  test("mjml-to-html accepts Notifuse JSON sample and returns HTML", async () => {
    const response = await hit("/mjml-to-html", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "text/html",
      },
      body: JSON.stringify(notifuseSample),
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("text/html")).toBe(true);
    expect(body).toContain("<!doctype html>");
  });

  test("mjml-to-mjml converts XML input to Notifuse JSON output", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "application/json",
      },
      body: validMjmlXml,
    });

    const body = (await response.json()) as NotifuseMjmlNode;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(body.type).toBe("mjml");
    expect(body.id).toBe("mjml-1");
    expect((body as unknown as { tagName?: string }).tagName).toBeUndefined();
  });

  test("mjml-to-mjml XML->JSON normalizes attributes to camelCase", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/xml",
        accept: "application/json",
      },
      body: "<mjml><mj-body><mj-section><mj-column><mj-text padding-top=\"10px\">Hello</mj-text></mj-column></mj-section></mj-body></mjml>",
    });

    const body = (await response.json()) as NotifuseMjmlNode;
    const textNode = findFirstType(body, "mj-text");

    expect(response.status).toBe(200);
    expect(textNode?.attributes?.paddingTop).toBe("10px");
  });

  test("mjml-to-mjml converts legacy JSON input to XML output", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/xml",
      },
      body: JSON.stringify(validMjmlAst),
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/xml")).toBe(true);
    expect(body).toContain("<mjml");
    expect(body).toContain("mj-text");
  });

  test("mjml-to-mjml converts Notifuse JSON input to XML output", async () => {
    const response = await hit("/mjml-to-mjml", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/xml",
      },
      body: JSON.stringify(validNotifuseJson),
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.startsWith("application/xml")).toBe(true);
    expect(body).toContain("padding-top=\"12px\"");
    expect(body).toContain("<mj-text");
  });
});

describe("error payload format", () => {
  test("returns JSON error object on route mismatch", async () => {
    const response = await hit("/missing-route", {
      headers: {
        authorization: `Bearer ${API_KEY}`,
      },
      body: "",
    });

    const body = (await response.json()) as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(body.error?.code).toBe("BAD_INPUT");
    expect(typeof body.error?.message).toBe("string");
  });
});
