// A small JSON Schema validator, dependency free, for the vendored Agent Trace schema only.
// It supports exactly the keywords that schema uses. A keyword it does not know throws, so a schema
// update that adds one cannot pass silently.

import traceSchema from "./trace-schema.json" with { type: "json" };

export const TRACE_SCHEMA: Schema = traceSchema as Schema;

export interface Schema {
  $ref?: string;
  type?: "object" | "string" | "array" | "integer";
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: string[];
  pattern?: string;
  minimum?: number;
  maxLength?: number;
  format?: "uuid" | "date-time" | "uri";
  definitions?: Record<string, Schema>;
  [annotation: string]: unknown;
}

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description"]);
const KEYWORDS = new Set([
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "pattern",
  "minimum",
  "maxLength",
  "format",
  "definitions",
]);

/** RFC 3339 date-time with real calendar values (no Feb 30, no hour 24); leap seconds (:60) are refused to stay on the strict side. */
function isDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se, oh, om] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  const days = new Date(Date.UTC(y!, mo!, 0)).getUTCDate(); // day 0 of the next month is the last day of this one
  return mo! >= 1 && mo! <= 12 && d! >= 1 && d! <= days && h! <= 23 && mi! <= 59 && se! <= 59 && oh! <= 23 && om! <= 59;
}

const FORMATS: Record<string, (s: string) => boolean> = {
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  "date-time": isDateTime,
  // RFC 3986: a scheme, then only unreserved, reserved and %XX characters.
  uri: (s) => /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/.test(s),
};

const has = (o: object, k: string) => Object.hasOwn(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function resolveRef(root: Schema, ref: string): Schema {
  const m = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(ref);
  const target = m && root.definitions && has(root.definitions, m[1]!) ? root.definitions[m[1]!] : undefined;
  if (!target) throw new Error(`unsupported $ref: ${ref}`);
  return target;
}

function check(root: Schema, schema: Schema, value: unknown, path: string, errors: string[]): void {
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`unsupported schema keyword: ${k}`);
  if (schema.$ref) {
    check(root, resolveRef(root, schema.$ref), value, path, errors);
    return;
  }
  const at = path || "(record)";
  switch (schema.type) {
    case "object":
      if (!isObject(value)) return void errors.push(`${at}: expected an object`);
      break;
    case "array":
      if (!Array.isArray(value)) return void errors.push(`${at}: expected an array`);
      break;
    case "string":
      if (typeof value !== "string") return void errors.push(`${at}: expected a string`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return void errors.push(`${at}: expected an integer`);
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string)) errors.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.format) {
      const f = FORMATS[schema.format];
      if (!f) throw new Error(`unsupported format: ${schema.format}`);
      if (!f(value)) errors.push(`${at}: not a valid ${schema.format}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) for (const [i, v] of value.entries()) check(root, schema.items, v, `${path}[${i}]`, errors);
  if (isObject(value)) {
    for (const r of schema.required ?? []) if (!has(value, r) || value[r] === undefined) errors.push(`${path ? `${path}.` : ""}${r}: required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // JSON.stringify drops it
      const sub = path ? `${path}.${k}` : k;
      if (has(props, k)) check(root, props[k]!, v, sub, errors);
      else if (schema.additionalProperties === false) errors.push(`${sub}: unknown field`);
      else if (isObject(schema.additionalProperties)) check(root, schema.additionalProperties, v, sub, errors);
    }
  }
}

/** Error messages for a record that breaks the vendored Agent Trace schema; an empty list means it is valid. */
export function validateTraceRecord(record: unknown, schema: Schema = TRACE_SCHEMA): string[] {
  const errors: string[] = [];
  check(schema, schema, record, "", errors);
  return errors;
}
