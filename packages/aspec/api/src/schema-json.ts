import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@aspec/validation';

/** Extracts JSON Schema (draft 2020-12) from a Standard Schema when available. */
export function schemaToJsonSchema(
  schema: StandardSchemaV1 | Record<string, unknown> | undefined,
  options: { target?: StandardJSONSchemaV1.Target } = {},
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (isPlainJsonSchema(schema)) return schema;
  const props = (schema as StandardSchemaV1)['~standard'] as Partial<StandardJSONSchemaV1.Props>;
  if (props?.jsonSchema?.input) {
    return props.jsonSchema.input({ target: options.target ?? 'draft-2020-12' });
  }
  // zod 4 also exposes toJSONSchema on the schema object
  const withMethod = schema as {
    toJSONSchema?: (opts?: { target?: string }) => Record<string, unknown>;
  };
  if (typeof withMethod.toJSONSchema === 'function') {
    try {
      const out = withMethod.toJSONSchema({ target: 'draft-2020-12' });
      return (out as { jsonSchema?: Record<string, unknown> }).jsonSchema ?? out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isPlainJsonSchema(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if ('~standard' in value) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.type === 'string' ||
    o.properties !== undefined ||
    o.$ref !== undefined ||
    Array.isArray(o.allOf) ||
    Array.isArray(o.oneOf) ||
    Array.isArray(o.anyOf)
  );
}
