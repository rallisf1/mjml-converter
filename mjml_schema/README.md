# MJML Component Specification Extractor

This tool extracts MJML component specifications from official MJML packages and generates a comprehensive JSON Schema file.

## Generated Files

### 1. `mjml-specs-raw.json` (82KB)

Raw extracted data containing:

- Component package names
- Allowed attributes (with MJML type definitions)
- Default attributes
- Converted JSON Schema attributes

### 2. `mjml-components-schema.json` (88KB)

A complete JSON Schema (draft 2020-12) file that defines:

- All 26 MJML components
- Component-specific attribute definitions
- **Regex pattern validations** for format constraints (18 components)
- Type validations
- Default values
- Enums for restricted-value attributes

### 3. `mjml-components-schema-ai.json` (61KB)

An AI-optimized JSON Schema specifically designed for AI/LLM use:

- **Simplified component set:** 21 components (excludes complex ones)
- **Excluded components:** mj-table, mj-accordion, mj-hero, mj-navbar, mj-carousel
- **Explicit attributes only:** No compound `padding` or `border` attributes
- **No inner- attributes:** Removes all `inner-*` attributes for simplicity
- **Hierarchy validation:** Enforces proper parent-child relationships
- **Built-in example:** Includes "Hello World" email demonstrating proper structure
- **AI-friendly comments:** Clear instructions on how to build email templates

Use this schema when building email templates with AI assistance for better validation and guidance.

### 4. `PATTERNS.md`

Comprehensive documentation of regex patterns:

- Pattern examples with valid/invalid inputs
- Common validation errors
- Testing guidelines
- Tips for using patterns

## Schema Comparison: Full vs AI-Optimized

| Feature                  | Full Schema                              | AI Schema                             |
| ------------------------ | ---------------------------------------- | ------------------------------------- |
| **Components**           | 26                                       | 21 (excludes 5 complex components)    |
| **Compound Attributes**  | Supports `padding`, `border`             | Only explicit (e.g., `paddingTop`)    |
| **Inner Attributes**     | Includes `inner-*` attributes            | All `inner-*` attributes removed      |
| **Hierarchy Validation** | No                                       | Yes (enforces parent-child rules)     |
| **Examples**             | No                                       | Yes (Hello World email template)      |
| **AI Instructions**      | No                                       | Yes (in `$comment` field)             |
| **Use Case**             | Complete MJML validation & documentation | AI/LLM email generation with guidance |
| **File Size**            | 88KB                                     | 61KB                                  |

### When to Use Each Schema

**Use Full Schema (`mjml-components-schema.json`) when:**

- Building comprehensive MJML validation tools
- Need support for all MJML components
- Working with existing MJML templates that use compound attributes
- Building documentation or reference tools

**Use AI Schema (`mjml-components-schema-ai.json`) when:**

- Building AI-powered email template generators
- Need hierarchy validation for correct structure
- Want simplified, explicit attribute names
- Prefer focused set of commonly-used components
- Building interactive email builders with AI assistance

## Components Included

### Full Schema Components (26)

**Body Components:**

- mj-accordion, mj-body, mj-button, mj-carousel, mj-column
- mj-divider, mj-group, mj-hero, mj-image, mj-navbar
- mj-raw, mj-section, mj-social, mj-spacer, mj-table
- mj-text, mj-wrapper

**Head Components:**

- mj-head, mj-attributes, mj-breakpoint, mj-font
- mj-html-attributes, mj-preview, mj-style, mj-title

**Root:**

- mjml

### AI Schema Components (21)

**Body Components:**

- ✓ mj-body, mj-button, mj-column, mj-divider, mj-group
- ✓ mj-image, mj-raw, mj-section, mj-social, mj-spacer
- ✓ mj-text, mj-wrapper
- ✓ mj-social-element (sub-component)

**Head Components:**

- ✓ mj-head, mj-attributes, mj-breakpoint, mj-font
- ✓ mj-html-attributes, mj-preview, mj-style, mj-title

**Root:**

- ✓ mjml

**Excluded (Complex Components):**

- ❌ mj-accordion (and related: mj-accordion-element, mj-accordion-title, mj-accordion-text)
- ❌ mj-carousel (and related: mj-carousel-image)
- ❌ mj-hero
- ❌ mj-navbar (and related: mj-navbar-link)
- ❌ mj-table

## Usage

### Generate/Update Schemas

```bash
npm run extract
```

This will:

1. Import all MJML component packages
2. Extract `allowedAttributes` and `defaultAttributes` from each component
3. Convert MJML type definitions to JSON Schema types
4. Generate both raw and schema JSON files

### Schema Structure

The generated schema follows the same structure as `mjml-components-schema-ai.json`:

- Uses `allOf` with conditional schemas for each component type
- Defines component-specific attributes under `properties.attributes.properties`
- Includes type information, descriptions, defaults, and enums

### Example Schema Usage

The schema can be used for:

- Validating MJML email templates in JSON format
- Generating form UIs for MJML components
- Auto-completion in editors
- Documentation generation
- Type checking in development tools

## Type Conversions

MJML type definitions are converted to JSON Schema types with pattern validation:

| MJML Type         | JSON Schema Type                           | Regex Pattern                                     |
| ----------------- | ------------------------------------------ | ------------------------------------------------- | ----- |
| `enum(a,b,c)`     | `{type: "string", enum: ["a","b","c"]}`    | N/A (enum)                                        |
| `unit(px,%)`      | `{type: "string", pattern: "..."}`         | `^\d+(\.\d+)?(px                                  | \%)$` |
| `unit(px,%){1,4}` | `{type: "string", pattern: "..."}`         | Supports 1-4 space-separated values               |
| `color`           | `{type: "string", pattern: "..."}`         | Hex, rgb(), rgba(), hsl(), hsla(), or color names |
| `boolean`         | `{type: "string", enum: ["true","false"]}` | N/A (enum)                                        |
| `integer`         | `{type: "integer"}`                        | N/A (numeric type)                                |
| `string`          | `{type: "string"}`                         | Context-dependent                                 |

## Pattern Validation

The schema includes comprehensive regex patterns for format validation:

### Unit Patterns

- **Pixels/Percentages**: `^\d+(\.\d+)?(px|%)$` - e.g., "15px", "50%", "12.5px"
- **Multiple Values**: `^\d+(\.\d+)?(px|%)(\\s+\d+(\.\d+)?(px|%))*$` - e.g., "10px 20px 30px"
- **Unitless**: `^\d+(\.\d+)?$` - e.g., "1", "1.5", "2" (for line-height)

### Color Patterns

`^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\s*\([^)]+\)|hsla?\s*\([^)]+\)|[a-zA-Z]+)$`

Accepts:

- Hex: `#fff`, `#ffffff`, `#ff000088`
- RGB: `rgb(255,255,255)`, `rgba(255,255,255,0.5)`
- HSL: `hsl(120,100%,50%)`, `hsla(120,100%,50%,0.5)`
- Named: `red`, `blue`, `transparent`

### Border Patterns

`^(\d+(\.\d+)?(px|em|rem)\s+(solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)\s+.+|none)$`

Examples: `1px solid #ccc`, `2px dashed red`, `none`

### URL Patterns

`^[^<>]*$`

Very permissive pattern that accepts:

- HTTP(S) URLs: `https://example.com/image.png`
- Relative URLs: `/images/logo.png`, `./asset.png`, `example.com/file.jpg`
- Data URIs: `data:image/png;base64,...`
- Liquid templates: `{{variable}}`, `{%if x%}{{url}}{%endif%}`
- Protocol-relative: `//cdn.example.com/image.png`
- Empty strings: `` (allowed)

Only blocks `<` and `>` characters to prevent HTML injection.

## Statistics

### Full Schema

- **Total Components:** 26
- **Total Attributes Extracted:** 300+
- **Components with Attributes:** 23 (excluding container components)
- **Schema Size:** 88KB

### AI Schema

- **Total Components:** 21 (5 excluded)
- **Filtered Attributes:** ~240 (removed compound and inner- attributes)
- **Components with Hierarchy Rules:** 8
- **Schema Size:** 61KB (31% smaller)

## Dependencies

- `mjml`: Official MJML library
- `mjml-core`: MJML core functionality

All component-specific packages are included as transitive dependencies of the main `mjml` package.
