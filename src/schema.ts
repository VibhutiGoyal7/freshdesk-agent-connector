/**
 * Minimal zod -> JSON Schema conversion, enough for MCP tool declarations.
 * Kept in-repo rather than pulling a dependency: the schemas here are simple,
 * and what the model sees is worth owning.
 */

import { z } from "zod";

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convert(schema);
}

function convert(s: z.ZodTypeAny): Record<string, unknown> {
  const def: any = (s as any)._def;
  const description = def.description;
  const withDesc = (o: Record<string, unknown>) => (description ? { ...o, description } : o);

  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!value.isOptional()) required.push(key);
    }
    return withDesc({
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    });
  }
  // zod hangs .describe() on the outermost wrapper, so Optional/Default must
  // carry the description through or the model never sees it.
  if (s instanceof z.ZodOptional) return withDesc(convert(def.innerType));
  if (s instanceof z.ZodDefault) {
    return withDesc({ ...convert(def.innerType), default: def.defaultValue() });
  }
  if (s instanceof z.ZodArray) {
    return withDesc({
      type: "array",
      items: convert(def.type),
      ...(def.maxLength?.value !== undefined ? { maxItems: def.maxLength.value } : {}),
    });
  }
  if (s instanceof z.ZodEnum) return withDesc({ type: "string", enum: def.values });
  if (s instanceof z.ZodString) {
    const checks: Record<string, unknown> = {};
    for (const c of def.checks ?? []) {
      if (c.kind === "min") checks.minLength = c.value;
      if (c.kind === "max") checks.maxLength = c.value;
      if (c.kind === "datetime") checks.format = "date-time";
    }
    return withDesc({ type: "string", ...checks });
  }
  if (s instanceof z.ZodNumber) {
    const checks: Record<string, unknown> = {};
    for (const c of def.checks ?? []) {
      // .positive() is an exclusive bound; emitting minimum: 0 would tell the
      // model that 0 is a valid id.
      if (c.kind === "min") checks[c.inclusive === false ? "exclusiveMinimum" : "minimum"] = c.value;
      if (c.kind === "max") checks[c.inclusive === false ? "exclusiveMaximum" : "maximum"] = c.value;
      if (c.kind === "int") checks.type = "integer";
    }
    return withDesc({ type: "number", ...checks });
  }
  if (s instanceof z.ZodBoolean) return withDesc({ type: "boolean" });
  return withDesc({});
}
