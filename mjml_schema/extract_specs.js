#!/usr/bin/env node

/**
 * MJML Component Specification Extractor
 * 
 * This script extracts component specifications from official MJML packages
 * and generates a JSON Schema file defining all components with their
 * attributes, defaults, and validation rules.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Component mapping: component name to npm package name
const COMPONENT_PACKAGES = {
    'mj-accordion': 'mjml-accordion',
    'mj-accordion-element': 'mjml-accordion',
    'mj-accordion-title': 'mjml-accordion',
    'mj-accordion-text': 'mjml-accordion',
    'mj-body': 'mjml-body',
    'mj-button': 'mjml-button',
    'mj-carousel': 'mjml-carousel',
    'mj-carousel-image': 'mjml-carousel',
    'mj-column': 'mjml-column',
    'mj-divider': 'mjml-divider',
    'mj-group': 'mjml-group',
    'mj-hero': 'mjml-hero',
    'mj-image': 'mjml-image',
    'mj-navbar': 'mjml-navbar',
    'mj-navbar-link': 'mjml-navbar',
    'mj-raw': 'mjml-raw',
    'mj-section': 'mjml-section',
    'mj-social': 'mjml-social',
    'mj-social-element': 'mjml-social',
    'mj-spacer': 'mjml-spacer',
    'mj-table': 'mjml-table',
    'mj-text': 'mjml-text',
    'mj-wrapper': 'mjml-wrapper',
    'mj-head': 'mjml-head',
    'mj-attributes': 'mjml-head-attributes',
    'mj-breakpoint': 'mjml-head-breakpoint',
    'mj-font': 'mjml-head-font',
    'mj-html-attributes': 'mjml-head-html-attributes',
    'mj-preview': 'mjml-head-preview',
    'mj-style': 'mjml-head-style',
    'mj-title': 'mjml-head-title',
    'mjml': 'mjml-core'
};

/**
 * Generate regex pattern for format validation
 */
function generatePattern(mjmlType, attrName) {
    if (!mjmlType || typeof mjmlType !== 'string') {
        return null;
    }

    const name = attrName.toLowerCase();

    // Handle unit types with specific units
    if (mjmlType.startsWith('unit(')) {
        const unitsMatch = mjmlType.match(/unit\((.*?)\)/);
        if (unitsMatch) {
            const units = unitsMatch[1].split(',').map(u => u.trim()).filter(u => u.length > 0);

            // Check if there's a multiplicity indicator like {1,4}
            const hasMultiplicity = mjmlType.includes('{');

            if (hasMultiplicity) {
                // For padding-like attributes that can have multiple values
                // e.g., "10px", "10px 20px", "10px 20px 30px", "10px 20px 30px 40px"
                const unitPattern = units.join('|');
                return `^\\d+(\\.\\d+)?(${unitPattern})(\\s+\\d+(\\.\\d+)?(${unitPattern}))*$`;
            }

            // Single value with specific units
            // Handle special case: "auto" can stand alone, other units need numbers
            // Also allow empty string with trailing |
            if (units.length > 0) {
                // If "auto" is one of the units, allow it standalone
                if (units.includes('auto')) {
                    const otherUnits = units.filter(u => u !== 'auto');
                    if (otherUnits.length > 0) {
                        const otherPattern = otherUnits.join('|');
                        return `^(\\d+(\\.\\d+)?(${otherPattern})|auto|)$`;
                    } else {
                        return `^(auto|)$`;
                    }
                } else {
                    const unitPattern = units.join('|');
                    return `^(\\d+(\\.\\d+)?(${unitPattern})|)$`;
                }
            } else {
                // Unitless number (e.g., line-height: 1.5)
                return `^(\\d+(\\.\\d+)?|)$`;
            }
        }
    }

    // Color format validation (hex, rgb, rgba, hsl, hsla, or named colors)
    if (mjmlType === 'color' || name.includes('color')) {
        // Accept: #fff, #ffffff, rgb(255,255,255), rgba(255,255,255,0.5), hsl(), hsla(), or color names
        return '^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\\s*\\([^)]+\\)|hsla?\\s*\\([^)]+\\)|[a-zA-Z]+)$';
    }

    // Border format validation (e.g., "1px solid #ccc")
    if (name.includes('border') && !name.includes('radius')) {
        return '^(\\d+(\\.\\d+)?(px|em|rem)\\s+(solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)\\s+.+|none)$';
    }

    // URL validation for href, src, srcset, background-url
    if (name.includes('url') || name.includes('href') || name.includes('src')) {
        // Very permissive: Allow full URLs, data URIs, Liquid templates ({{ or {%),
        // relative paths, empty strings, etc. Just exclude dangerous characters for basic safety.
        return '^[^<>]*$'; // Allow anything except < > (prevent HTML injection)
    }

    // Font family validation (allow multiple fonts separated by commas)
    if (name.includes('font') && name.includes('family')) {
        return '^[^;{}]+$'; // Prevent CSS injection
    }

    // Generic pixel/percentage validation if name suggests it
    if ((name.includes('width') || name.includes('height') || name.includes('size')) && !mjmlType.startsWith('unit(')) {
        return '^(\\d+(\\.\\d+)?(px|%|em|rem|auto)|auto|)$'; // Allow empty string with trailing |
    }

    // Padding/margin/spacing validation
    if ((name.includes('padding') || name.includes('margin') || name.includes('spacing')) && !mjmlType.startsWith('unit(')) {
        return '^\\d+(\\.\\d+)?(px|%|em|rem)(\\s+\\d+(\\.\\d+)?(px|%|em|rem))*$';
    }

    return null;
}

/**
 * Convert MJML type definition to JSON Schema type
 */
function mjmlTypeToJsonSchema(mjmlType, attrName, defaultValue) {
    if (!mjmlType || typeof mjmlType !== 'string') {
        return { type: 'string' };
    }

    const name = attrName.toLowerCase();
    const result = { type: 'string' };

    // Handle enum types
    if (mjmlType.startsWith('enum(')) {
        const values = mjmlType.match(/enum\((.*?)\)/)?.[1]?.split(',') || [];
        result.enum = values;
        return result;
    }

    // Handle boolean
    if (mjmlType === 'boolean' || defaultValue === true || defaultValue === false) {
        result.enum = ['true', 'false'];
        return result;
    }

    // Handle integer
    if (mjmlType === 'integer') {
        return { type: 'integer' };
    }

    // Add pattern validation
    const pattern = generatePattern(mjmlType, attrName);
    if (pattern) {
        result.pattern = pattern;
    }

    return result;
}

/**
 * Generate description for an attribute
 */
function generateAttributeDescription(attrName, defaultValue, mjmlType) {
    const name = attrName.toLowerCase();

    // Generate format hint from MJML type
    let formatHint = '';
    if (mjmlType && mjmlType.startsWith('unit(')) {
        const unitsMatch = mjmlType.match(/unit\((.*?)\)/);
        if (unitsMatch) {
            const units = unitsMatch[1].split(',').map(u => u.trim()).filter(u => u.length > 0);
            if (units.length > 0) {
                formatHint = ` Units: ${units.join(', ')}.`;
            } else {
                formatHint = ' Unitless number.';
            }
        }
    }

    if (name.includes('color')) return `Color value (e.g., "#ffffff", "red", "rgb(255,255,255)").${formatHint}`;
    if (name.includes('width')) return `Width value (e.g., "100px", "50%", "auto").${formatHint}`;
    if (name.includes('height')) return `Height value (e.g., "100px", "auto").${formatHint}`;
    if (name.includes('padding')) return `Padding value. Supports 1-4 values (e.g., "10px", "10px 20px").${formatHint}`;
    if (name.includes('margin')) return `Margin value. Supports 1-4 values (e.g., "10px", "10px 20px").${formatHint}`;
    if (name.includes('border') && name.includes('radius')) return `Border radius (e.g., "4px", "50%").${formatHint}`;
    if (name.includes('border')) return `Border definition (e.g., "1px solid #ccc", "2px dashed red").${formatHint}`;
    if (name === 'align' || name === 'textalign') return 'Text/content alignment.';
    if (name === 'verticalalign') return 'Vertical alignment.';
    if (name.includes('font') && name.includes('family')) return 'Font family (e.g., "Arial, sans-serif", "Roboto, sans-serif").';
    if (name.includes('font') && name.includes('size')) return `Font size (e.g., "16px", "1.2em").${formatHint}`;
    if (name.includes('font') && name.includes('weight')) return 'Font weight (e.g., "normal", "bold", "400", "700").';
    if (name === 'href') return 'Link URL. Supports Liquid templating (e.g., "{{variable}}").';
    if (name === 'src') return 'Image/resource URL. Supports Liquid templating.';
    if (name === 'alt') return 'Alternative text for accessibility and when images fail to load.';
    if (name === 'title') return 'Title text shown as tooltip on hover.';
    if (name === 'target') return 'Link target (e.g., "_blank", "_self").';
    if (name === 'rel') return 'Link relationship (e.g., "noopener noreferrer").';
    if (name.includes('background') && name.includes('url')) return 'Background image URL.';
    if (name.includes('background') && name.includes('position')) return 'Background position (e.g., "center", "top left", "50% 50%").';
    if (name.includes('background') && name.includes('size')) return 'Background size (e.g., "cover", "contain", "100px 200px").';
    if (name.includes('background') && name.includes('repeat')) return 'Background repeat (e.g., "repeat", "no-repeat").';
    if (name === 'cssclass') return 'CSS class name to apply to the generated HTML element.';
    if (name === 'direction') return 'Text/content direction (ltr or rtl).';
    if (name.includes('spacing')) return `Spacing value (e.g., "0.5px", "0.1em").${formatHint}`;

    return `${attrName} attribute${formatHint}`;
}

/**
 * Convert camelCase attribute name to kebab-case
 */
function camelToKebab(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert kebab-case component name to PascalCase export name
 * e.g., "mj-social-element" → "SocialElement", "mj-navbar-link" → "NavbarLink"
 */
function kebabToPascal(componentName) {
    return componentName
        .replace('mj-', '')
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

/**
 * Extract component specifications
 */
async function extractComponentSpecs() {
    const specs = {};

    console.log('Extracting MJML component specifications...\n');

    for (const [componentName, packageName] of Object.entries(COMPONENT_PACKAGES)) {
        try {
            // Try to import the component package
            const modulePath = `mjml-core`;
            let componentModule;

            try {
                // Most components are in their own packages
                componentModule = await import(packageName);
            } catch (err) {
                // Some components might be in mjml-core
                try {
                    componentModule = await import('mjml-core');
                } catch (err2) {
                    console.log(`  ⚠️  Could not import ${packageName} for ${componentName}`);
                    continue;
                }
            }

            // Get the component class
            // For single-component packages, default IS the class
            // For multi-component packages, default is a plain object;
            // the actual class is a named export matching the PascalCase name
            let Component = componentModule.default;

            if (!Component || typeof Component !== 'function' || !Component.allowedAttributes) {
                const exportName = kebabToPascal(componentName);
                if (componentModule[exportName] && typeof componentModule[exportName] === 'function') {
                    Component = componentModule[exportName];
                }
            }

            if (!Component || typeof Component !== 'function') {
                console.log(`  ⚠️  Could not find component class for ${componentName}`);
                continue;
            }

            // Extract allowed attributes and default attributes
            const allowedAttributes = Component.allowedAttributes || {};
            const defaultAttributes = Component.defaultAttributes || {};

            // allowedAttributes is an object where keys are attribute names
            // and values are type definitions (e.g., "color", "unit(px,%)", "enum(left,right)")
            const attrNames = Object.keys(allowedAttributes);

            specs[componentName] = {
                packageName,
                allowedAttributes,
                defaultAttributes,
                attributes: {}
            };

            // Generate attribute definitions
            for (const attr of attrNames) {
                const mjmlType = allowedAttributes[attr];
                const defaultValue = defaultAttributes[attr];
                const attrType = mjmlTypeToJsonSchema(mjmlType, attr, defaultValue);
                const description = generateAttributeDescription(attr, defaultValue, mjmlType);

                specs[componentName].attributes[attr] = {
                    ...attrType,
                    description
                };

                if (defaultValue !== undefined && defaultValue !== null) {
                    specs[componentName].attributes[attr].default = defaultValue;
                }
            }

            console.log(`  ✓ ${componentName}: ${attrNames.length} attributes`);

        } catch (error) {
            console.log(`  ✗ Error processing ${componentName}:`, error.message);
        }
    }

    // Ensure mjml root element exists in specs (it has no component class in mjml-core)
    if (!specs['mjml']) {
        specs['mjml'] = {
            packageName: 'mjml-core',
            allowedAttributes: {},
            defaultAttributes: {},
            attributes: {}
        };
        console.log(`  ✓ mjml: created root element spec`);
    }

    // ===== Documentation patches =====
    // Inject attributes that are documented but not in individual component allowedAttributes

    // 1. Add css-class to all body components (global attribute from BodyComponent base class)
    const HEAD_COMPONENTS = new Set([
        'mjml', 'mj-head', 'mj-attributes', 'mj-breakpoint',
        'mj-font', 'mj-html-attributes', 'mj-preview', 'mj-style', 'mj-title'
    ]);

    console.log('\nApplying documentation patches...');

    for (const [componentName, spec] of Object.entries(specs)) {
        if (!HEAD_COMPONENTS.has(componentName) && spec.attributes) {
            spec.allowedAttributes['css-class'] = 'string';
            spec.attributes['css-class'] = {
                type: 'string',
                description: 'CSS class name to apply to the generated HTML element.'
            };
        }
    }
    console.log('  + Injected css-class into all body components');

    // 2. Add mjml root element attributes (handled in mjml-core/lib/index.js:215-217)
    if (specs['mjml']) {
        const mjmlRootAttrs = {
            'owa': { mjmlType: 'string', default: 'mobile', description: 'Outlook Web App rendering mode. Set to "desktop" to force desktop layout in OWA.' },
            'lang': { mjmlType: 'string', default: 'und', description: 'Language of the email content (e.g., "en", "fr"). Defaults to "und" (undefined).' },
            'dir': { mjmlType: 'enum(ltr,rtl,auto)', default: 'auto', description: 'Text direction for the email (ltr = left-to-right, rtl = right-to-left). Defaults to "auto".' }
        };

        specs['mjml'].allowedAttributes = specs['mjml'].allowedAttributes || {};
        specs['mjml'].defaultAttributes = specs['mjml'].defaultAttributes || {};

        for (const [attr, def] of Object.entries(mjmlRootAttrs)) {
            specs['mjml'].allowedAttributes[attr] = def.mjmlType;
            const attrType = mjmlTypeToJsonSchema(def.mjmlType, attr, def.default);
            specs['mjml'].attributes[attr] = {
                ...attrType,
                description: def.description,
                default: def.default
            };
            specs['mjml'].defaultAttributes[attr] = def.default;
        }
        console.log('  + Added owa, lang, dir to mjml root');
    }

    return specs;
}

/**
 * Generate JSON Schema from component specifications
 */
function generateJsonSchema(specs) {
    const componentTypes = Object.keys(specs);

    const schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://notifuse.com/schemas/mjml-components.json",
        "title": "MJML Components Schema",
        "description": "Auto-generated JSON Schema for MJML components extracted from official MJML packages",
        "type": "object",
        "required": ["id", "type"],
        "properties": {
            "id": {
                "type": "string",
                "description": "Unique identifier for the component"
            },
            "type": {
                "type": "string",
                "enum": componentTypes,
                "description": "MJML component type"
            },
            "children": {
                "type": "array",
                "description": "Child components",
                "items": { "$ref": "#" }
            },
            "attributes": {
                "type": "object",
                "description": "Component attributes",
                "additionalProperties": true
            },
            "content": {
                "type": "string",
                "description": "Text/HTML content for leaf components"
            }
        },
        "allOf": []
    };

    // Generate conditional schemas for each component
    for (const [componentName, spec] of Object.entries(specs)) {
        const componentSchema = {
            "if": {
                "properties": {
                    "type": { "const": componentName }
                }
            },
            "then": {
                "description": `${componentName} component`,
                "properties": {
                    "attributes": {
                        "type": "object",
                        "additionalProperties": true,
                        "properties": {}
                    }
                }
            }
        };

        // Add attribute definitions
        if (spec.attributes && Object.keys(spec.attributes).length > 0) {
            for (const [attrName, attrDef] of Object.entries(spec.attributes)) {
                componentSchema.then.properties.attributes.properties[attrName] = {
                    ...attrDef
                };
            }
        }

        schema.allOf.push(componentSchema);
    }

    return schema;
}

/**
 * Generate AI-optimized JSON Schema with hierarchy validation
 */
function generateAISchema(specs) {
    // Components to exclude for AI use
    const excludedComponents = [
        'mj-table',
        'mj-accordion',
        'mj-accordion-element',
        'mj-accordion-title',
        'mj-accordion-text',
        'mj-hero',
        'mj-navbar',
        'mj-navbar-link',
        'mj-carousel',
        'mj-carousel-image'
    ];

    // Attributes to exclude (compound and inner- attributes)
    const excludedAttributes = [
        'padding',         // Use padding-top, padding-right, etc. instead
        'border',          // Use border-top, border-right, etc. instead
        'inner-padding',
        'inner-padding-top',
        'inner-padding-right',
        'inner-padding-bottom',
        'inner-padding-left',
        'inner-border',
        'inner-border-top',
        'inner-border-right',
        'inner-border-bottom',
        'inner-border-left',
        'inner-border-radius',
        'inner-background-color'
    ];

    // Filter specs
    const filteredSpecs = {};
    for (const [componentName, spec] of Object.entries(specs)) {
        if (excludedComponents.includes(componentName)) {
            continue;
        }

        filteredSpecs[componentName] = {
            ...spec,
            attributes: {}
        };

        // Filter attributes
        for (const [attrName, attrDef] of Object.entries(spec.attributes || {})) {
            if (!excludedAttributes.includes(attrName)) {
                filteredSpecs[componentName].attributes[attrName] = attrDef;
            }
        }
    }

    const componentTypes = Object.keys(filteredSpecs);

    // Hierarchy definitions
    const hierarchyRules = {
        'mjml': ['mj-head', 'mj-body'],
        'mj-head': ['mj-attributes', 'mj-breakpoint', 'mj-font', 'mj-html-attributes', 'mj-preview', 'mj-style', 'mj-title', 'mj-raw'],
        'mj-body': ['mj-wrapper', 'mj-section', 'mj-raw'],
        'mj-wrapper': ['mj-section', 'mj-raw'],
        'mj-section': ['mj-column', 'mj-group', 'mj-raw'],
        'mj-group': ['mj-column'],
        'mj-column': ['mj-text', 'mj-button', 'mj-image', 'mj-divider', 'mj-spacer', 'mj-social', 'mj-raw'],
        'mj-social': ['mj-social-element'],
        'mj-attributes': ['mj-text', 'mj-button', 'mj-image', 'mj-section', 'mj-column', 'mj-wrapper', 'mj-group', 'mj-divider', 'mj-spacer', 'mj-social', 'mj-social-element']
    };

    const basicExample = {
        "description": "Basic 'Hello World' email showing proper hierarchy and explicit attribute usage",
        "value": {
            "id": "root-1",
            "type": "mjml",
            "children": [
                {
                    "id": "body-1",
                    "type": "mj-body",
                    "attributes": {
                        "backgroundColor": "#f4f4f4"
                    },
                    "children": [
                        {
                            "id": "section-1",
                            "type": "mj-section",
                            "attributes": {
                                "backgroundColor": "#ffffff",
                                "paddingTop": "20px",
                                "paddingBottom": "20px"
                            },
                            "children": [
                                {
                                    "id": "column-1",
                                    "type": "mj-column",
                                    "children": [
                                        {
                                            "id": "text-1",
                                            "type": "mj-text",
                                            "content": "<h1>Hello World!</h1><p>This is a simple email built with MJML.</p>",
                                            "attributes": {
                                                "align": "center",
                                                "color": "#333333",
                                                "fontSize": "16px",
                                                "paddingTop": "10px",
                                                "paddingBottom": "10px"
                                            }
                                        },
                                        {
                                            "id": "button-1",
                                            "type": "mj-button",
                                            "content": "Click Me",
                                            "attributes": {
                                                "href": "https://example.com",
                                                "backgroundColor": "#007bff",
                                                "color": "#ffffff",
                                                "borderRadius": "4px",
                                                "paddingTop": "10px",
                                                "paddingBottom": "10px"
                                            }
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    };

    const schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://notifuse.com/schemas/mjml-components-ai.json",
        "title": "MJML Components Schema (AI-Optimized)",
        "description": "JSON Schema for generating valid MJML email templates. This schema defines a tree structure where each node has: 'id' (string), 'type' (component name), optional 'children' (array of nodes), optional 'attributes' (object with component-specific properties), and optional 'content' (string for text/HTML). The schema enforces parent-child hierarchy rules and validates attribute formats with regex patterns.",
        "$comment": "STRUCTURE RULES: Every object MUST have 'id' and 'type'. Root MUST be type='mjml'. Standard email structure: mjml > mj-body > mj-section > mj-column > content components (mj-text, mj-button, mj-image). ATTRIBUTE RULES: Use explicit attributes only: 'paddingTop'/'paddingRight'/'paddingBottom'/'paddingLeft' instead of 'padding', 'borderTop'/'borderRight' etc instead of 'border'. NO 'inner-*' attributes allowed. COMPONENT RESTRICTIONS: Do NOT use mj-table, mj-accordion, mj-hero, mj-navbar, or mj-carousel (excluded for simplicity). HIERARCHY: Check 'Allowed children' in component descriptions for valid nesting. EXAMPLES: See the examples array for a complete 'Hello World' template structure.",
        "type": "object",
        "examples": [basicExample],
        "required": ["id", "type"],
        "properties": {
            "id": {
                "type": "string",
                "description": "Unique identifier for the component"
            },
            "type": {
                "type": "string",
                "enum": componentTypes,
                "description": "MJML component type"
            },
            "children": {
                "type": "array",
                "description": "Child components",
                "items": { "$ref": "#" }
            },
            "attributes": {
                "type": "object",
                "description": "Component attributes",
                "additionalProperties": true
            },
            "content": {
                "type": "string",
                "description": "Text/HTML content for leaf components"
            }
        },
        "allOf": []
    };

    // Generate conditional schemas with hierarchy validation
    for (const [componentName, spec] of Object.entries(filteredSpecs)) {
        const componentSchema = {
            "if": {
                "properties": {
                    "type": { "const": componentName }
                }
            },
            "then": {
                "description": `${componentName} component`,
                "properties": {
                    "attributes": {
                        "type": "object",
                        "additionalProperties": true,
                        "properties": {}
                    }
                }
            }
        };

        // Add attribute definitions
        if (spec.attributes && Object.keys(spec.attributes).length > 0) {
            for (const [attrName, attrDef] of Object.entries(spec.attributes)) {
                componentSchema.then.properties.attributes.properties[attrName] = {
                    ...attrDef
                };
            }
        }

        // Add children validation if hierarchy rules exist
        if (hierarchyRules[componentName]) {
            componentSchema.then.properties.children = {
                "type": "array",
                "description": `Allowed children: ${hierarchyRules[componentName].join(', ')}`,
                "items": {
                    "properties": {
                        "type": {
                            "enum": hierarchyRules[componentName]
                        }
                    }
                }
            };
        }

        schema.allOf.push(componentSchema);
    }

    return schema;
}

/**
 * Main execution
 */
async function main() {
    console.log('MJML Component Specification Extractor');
    console.log('======================================\n');

    // Extract component specifications
    const specs = await extractComponentSpecs();

    console.log(`\nExtracted specifications for ${Object.keys(specs).length} components\n`);

    // Generate full JSON Schema
    const schema = generateJsonSchema(specs);

    // Generate AI-optimized JSON Schema
    console.log('Generating AI-optimized schema...');
    const aiSchema = generateAISchema(specs);
    console.log(`✓ AI schema includes ${aiSchema.properties.type.enum.length} components (excluded complex ones)\n`);

    // Write intermediate specs file
    const specsOutputPath = path.join(__dirname, 'mjml-specs-raw.json');
    fs.writeFileSync(specsOutputPath, JSON.stringify(specs, null, 2));
    console.log(`✓ Raw specifications written to: ${specsOutputPath}`);

    // Write full JSON Schema file
    const schemaOutputPath = path.join(__dirname, 'mjml-components-schema.json');
    fs.writeFileSync(schemaOutputPath, JSON.stringify(schema, null, 2));
    console.log(`✓ Full JSON Schema written to: ${schemaOutputPath}`);

    // Write AI JSON Schema file
    const aiSchemaOutputPath = path.join(__dirname, 'mjml-components-schema-ai.json');
    fs.writeFileSync(aiSchemaOutputPath, JSON.stringify(aiSchema, null, 2));
    console.log(`✓ AI JSON Schema written to: ${aiSchemaOutputPath}`);

    console.log('\n✅ Extraction complete!');
}

// Run the script
main().catch(error => {
    console.error('❌ Error:', error);
    process.exit(1);
});

