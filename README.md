I recently switched to [Notifuse](https://github.com/Notifuse/notifuse), only to find out it only supports MJML as code input, while our design tool only exports HTML... so I vibe coded:

# mjml-converter

## What it is

`mjml-converter` is a Typescript REST API for MJML and HTML conversion, primarily to use with the [Notifuse API](https://docs.notifuse.com/api-reference/list-templates).

It exposes three endpoints:

- `POST /html-to-mjml`
- `POST /mjml-to-html`
- `POST /mjml-to-mjml`

For MJML JSON payloads, the API uses a Notifuse-style schema:

- `id`
- `type`
- `children`
- `attributes`
- `content`

Standard AST JSON input using `tagName` is also accepted for 3rd-party (a.k.a. not Notifuse data) compatibility.

Authentication is API-key based via:

- `Authorization: Bearer <API_KEY>`

## How to Install

### Bun

1. Install dependencies:

```bash
bun install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Set `API_KEY` in `.env`.

4. Run the API:

```bash
bun run index.ts
```

By default, the service runs on port `3000`. You can override it with `PORT`.

### Docker

1. Build the image:

```bash
docker build -t mjml-converter .
```

2. Run the container:

```bash
docker run --rm -p 3000:3000 -e API_KEY=MY_STRONG_API_KEY -e PORT=3000 mjml-converter
```

`API_KEY` is required by the container at startup.

## How to use

### Authentication

All endpoints require a bearer token header:

```http
Authorization: Bearer MY_STRONG_API_KEY
```

If the header is missing or invalid, the API returns `403`.

### Content negotiation rules

- `Content-Type` defines the input format.
- `Accept` defines the output format.
- Missing/unsupported `Accept` returns `406`.
- Missing/unsupported `Content-Type` returns `415`.
- Invalid payloads return `400`.
- For `POST /mjml-to-mjml`, using the same `Content-Type` and `Accept` returns `400` (no conversion requested).

### Endpoints

1. `POST /html-to-mjml`
- Input: `Content-Type: text/html`
- Output (`Accept`):
- `application/xml` (MJML XML)
- `application/json` (Notifuse-style MJML JSON)

2. `POST /mjml-to-html`
- Input (`Content-Type`):
- `application/xml` (MJML XML)
- `application/json` (Notifuse-style MJML JSON or legacy `tagName` JSON)
- Output (`Accept`):
- `text/html`
- `application/json` as `{ "html": "...", "warnings": [...] }`

3. `POST /mjml-to-mjml`
- Input (`Content-Type`): `application/xml` or `application/json`
- Output (`Accept`): `application/xml` or `application/json`
- Must be cross-format only:
- XML -> JSON
- JSON -> XML

### Example requests

`API_KEY` can be exported once:

```bash
export API_KEY=MY_STRONG_API_KEY
```

1. HTML -> MJML XML

```bash
curl -X POST http://localhost:3000/html-to-mjml \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: text/html" \
  -H "Accept: application/xml" \
  --data '<div>Hello from HTML</div>'
```

2. MJML XML -> HTML

```bash
curl -X POST http://localhost:3000/mjml-to-html \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/xml" \
  -H "Accept: text/html" \
  --data '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>'
```

3. MJML JSON (Notifuse) -> MJML XML

```bash
curl -X POST http://localhost:3000/mjml-to-mjml \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/xml" \
  --data '{
    "id": "mjml-1",
    "type": "mjml",
    "children": [
      {
        "id": "mj-body-1",
        "type": "mj-body",
        "children": [
          {
            "id": "mj-section-1",
            "type": "mj-section",
            "children": [
              {
                "id": "mj-column-1",
                "type": "mj-column",
                "children": [
                  {
                    "id": "mj-text-1",
                    "type": "mj-text",
                    "content": "Hello from Notifuse JSON"
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }'
```

### Error responses

Errors are returned as JSON:

```json
{"error":{"code":"BAD_INPUT","message":"..."}}
```

Common status codes:

- `400` invalid input payload
- `403` missing or invalid API key
- `406` unacceptable `Accept` header
- `415` unsupported `Content-Type`

## License

MIT. See [LICENSE](./LICENSE).
