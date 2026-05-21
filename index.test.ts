import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { createApiFetchHandler, type MjmlAstNode, type NotifuseMjmlNode } from "./index";

const API_KEY = "test-key";
const handler = createApiFetchHandler({ apiKey: API_KEY });

const notifuseSample = JSON.parse(
  readFileSync(new URL("./mjml-sample.json", import.meta.url), "utf8"),
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
    expect(body).toContain("<mjml>");
    expect(body).toContain("<mj-raw>");
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
    expect(bodyNode?.id).toBe("mj-body-1");
    expect(sectionNode?.id).toBe("mj-section-1");
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
