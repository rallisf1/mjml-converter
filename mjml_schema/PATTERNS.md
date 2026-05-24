# MJML Component Attribute Pattern Validation

This document shows example patterns from the generated JSON Schema for validating MJML component attributes.

## Summary Statistics

- **Total Components:** 26
- **Components with Pattern Validation:** 18
- **Common Pattern Types:** Units, Colors, Borders, URLs

## Pattern Examples

### 1. Unit Validation (Single Value)

**Pattern:** `^\d+(\.\d+)?(px|%)$`

**Validates:**

- ✓ `15px`
- ✓ `50%`
- ✓ `12.5px`
- ✓ `100.25%`
- ✗ `15` (missing unit)
- ✗ `15pt` (invalid unit)
- ✗ `px15` (wrong order)

**Used by attributes:**

- `width`, `height`, `icon-width`, `icon-height`
- `font-size`, `border-width`

### 2. Unit Validation (Multiple Values)

**Pattern:** `^\d+(\.\d+)?(px|%)(\\s+\d+(\.\d+)?(px|%))*$`

**Validates:**

- ✓ `10px`
- ✓ `10px 20px`
- ✓ `10px 20px 30px`
- ✓ `10px 20px 30px 40px`
- ✓ `10.5px 20.25px`
- ✗ `10px,20px` (comma separator)
- ✗ `10px  20px` (double space)

**Used by attributes:**

- `padding`, `margin`, `inner-padding`
- `padding-top/right/bottom/left` (when unit type allows multiple)

### 3. Color Validation

**Pattern:** `^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\s*\([^)]+\)|hsla?\s*\([^)]+\)|[a-zA-Z]+)$`

**Validates:**

**Hex Colors:**

- ✓ `#fff`
- ✓ `#ffffff`
- ✓ `#ff000088` (with alpha)
- ✗ `#ff` (too short)
- ✗ `#gggggg` (invalid hex)

**RGB/RGBA:**

- ✓ `rgb(255, 255, 255)`
- ✓ `rgba(255, 255, 255, 0.5)`
- ✓ `rgb(100%, 50%, 0%)`

**HSL/HSLA:**

- ✓ `hsl(120, 100%, 50%)`
- ✓ `hsla(120, 100%, 50%, 0.5)`

**Named Colors:**

- ✓ `red`
- ✓ `blue`
- ✓ `transparent`
- ✓ `rebeccapurple`

**Used by attributes:**

- `color`, `background-color`, `border-color`
- `container-background-color`
- Any attribute with "color" in the name

### 4. Border Validation

**Pattern:** `^(\d+(\.\d+)?(px|em|rem)\s+(solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)\s+.+|none)$`

**Validates:**

- ✓ `1px solid #ccc`
- ✓ `2px dashed red`
- ✓ `1.5px dotted rgba(0,0,0,0.5)`
- ✓ `3px double blue`
- ✓ `none`
- ✗ `1px #ccc` (missing style)
- ✗ `solid red` (missing width)

**Used by attributes:**

- `border`, `border-top`, `border-right`, `border-bottom`, `border-left`
- `inner-border`, `inner-border-top`, etc.

### 5. Border Radius

**Pattern:** None (generic string)

**Valid Examples:**

- `4px`
- `50%`
- `10px 20px`
- `10px 20px 30px 40px`

**Used by attributes:**

- `border-radius`, `inner-border-radius`

### 6. URL Validation

**Pattern:** `^[^<>]*$`

**Validates:**

This is a very permissive pattern that allows almost all URL formats while preventing HTML injection.

**HTTP(S) URLs:**

- ✓ `https://example.com/image.png`
- ✓ `http://example.com/file.jpg`
- ✓ `example.com/image.png` (relative domain)

**Data URIs:**

- ✓ `data:image/png;base64,iVBORw0KGgo...`
- ✓ `data:image/svg+xml,%3Csvg...`

**Liquid Templates:**

- ✓ `{{image_url}}`
- ✓ `{%if user%}{{user.avatar}}{%endif%}`
- ✓ `https://example.com/{{path}}`

**Relative & Protocol-Relative URLs:**

- ✓ `//cdn.example.com/image.png` (protocol-relative)
- ✓ `/images/logo.png` (absolute path)
- ✓ `./assets/image.png` (relative path)
- ✓ `../parent/image.png` (parent directory)

**Empty Strings:**

- ✓ `` (empty string allowed)

**Not Allowed (prevents HTML injection):**

- ✗ `<script>alert('xss')</script>`
- ✗ `<img src=x>`

**Used by attributes:**

- `href`, `src`, `srcset`, `background-url`
- `icon-wrapped-url`, `icon-unwrapped-url`
- Any attribute with "url", "href", or "src" in the name

### 7. Unitless Numbers

**Pattern:** `^\d+(\.\d+)?$`

**Validates:**

- ✓ `1`
- ✓ `1.5`
- ✓ `2.25`
- ✗ `1.5px` (has unit)
- ✗ `1,5` (comma decimal)

**Used by attributes:**

- `line-height` (when unitless)
- `font-weight` (numeric values)

### 8. Enum Validation

**No Pattern** (uses `enum` constraint)

**Example - Alignment:**

```json
{
  "type": "string",
  "enum": ["left", "right", "center", "justify"]
}
```

**Validates:**

- ✓ `left`
- ✓ `center`
- ✗ `middle`
- ✗ `Left` (case sensitive)

**Used by attributes:**

- `align`, `text-align`, `vertical-align`
- `direction`, `mode`, `target`

### 9. Font Family

**Pattern:** `^[^;{}]+$`

**Purpose:** Prevents CSS injection

**Validates:**

- ✓ `Arial, sans-serif`
- ✓ `"Roboto", Helvetica, Arial`
- ✓ `'Times New Roman', serif`
- ✗ `Arial; color: red` (injection attempt)
- ✗ `Arial { color: red }` (injection attempt)

**Used by attributes:**

- `font-family`

## Testing Pattern Validation

You can test these patterns using JSON Schema validators. Example using Node.js:

```javascript
const Ajv = require('ajv')
const ajv = new Ajv()
const schema = require('./mjml-components-schema.json')

// Validate an mj-button component
const data = {
  id: 'btn-1',
  type: 'mj-button',
  attributes: {
    'background-color': '#ff0000', // Valid
    width: '200px', // Valid
    padding: '10px 20px' // Valid
  }
}

const validate = ajv.compile(schema)
const valid = validate(data)

if (!valid) {
  console.log(validate.errors)
}
```

## Common Validation Errors

### 1. Missing Units

```json
{
  "width": "100" // ❌ Should be "100px" or "100%"
}
```

### 2. Invalid Unit Type

```json
{
  "padding": "10pt" // ❌ Should use px, %, em, or rem
}
```

### 3. Invalid Color Format

```json
{
  "color": "#ff" // ❌ Should be #fff or #ffffff
}
```

### 4. Invalid Border Format

```json
{
  "border": "1px #ccc" // ❌ Missing border style (solid, dashed, etc.)
}
```

### 5. Invalid URL Format

```json
{
  "href": "<script>alert('xss')</script>" // ❌ Contains < or > characters (HTML injection risk)
}
```

## Tips for Using Patterns

1. **Always include units** for dimensional attributes (px, %, em, rem)
2. **Use standard color formats** (hex, rgb, rgba, hsl, hsla, or named colors)
3. **Complete border definitions** must include width, style, and color
4. **URLs are very permissive** - Full URLs, relative paths, data URIs, Liquid templates, and empty strings are all allowed. Only < and > characters are blocked for security.
5. **Enum values are case-sensitive** - use lowercase for alignment, direction, etc.

## Custom Validation

If you need additional validation beyond these patterns, you can:

1. Extend the schema with custom patterns
2. Add `format` keywords (e.g., `"format": "uri"`)
3. Use `minLength`, `maxLength` for string constraints
4. Add `minimum`, `maximum` for numeric constraints
