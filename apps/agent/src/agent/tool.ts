// Turn a shared zod (v3) schema from @rove/shared/agent.ts into a tool the SDK's toolRunner can call.
// The SDK's betaZodTool expects zod v4 schemas, so we convert our v3 schemas to JSON Schema here (only the
// zod features the contracts use) and validate inputs with the original v3 schema before `run`.

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

type Json = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): Json {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind; description?: string };
  const withDesc = (s: Json): Json => (schema.description ? { ...s, description: schema.description } : s);
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Json = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return withDesc({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: Json = { type: "string" };
      for (const check of (schema as z.ZodString)._def.checks) {
        if (check.kind === "regex") out.pattern = check.regex.source;
        if (check.kind === "min") out.minLength = check.value;
        if (check.kind === "max") out.maxLength = check.value;
      }
      return withDesc(out);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: Json = { type: "number" };
      for (const check of (schema as z.ZodNumber)._def.checks) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      }
      return withDesc(out);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDesc({ type: "boolean" });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDesc({ type: "string", enum: (schema as z.ZodEnum<[string, ...string[]]>).options });
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const arr = schema as z.ZodArray<z.ZodTypeAny>;
      const out: Json = { type: "array", items: toJsonSchema(arr.element) };
      if (arr._def.minLength) out.minItems = arr._def.minLength.value;
      if (arr._def.maxLength) out.maxItems = arr._def.maxLength.value;
      return withDesc(out);
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = toJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
      return schema.description ? { ...inner, description: schema.description } : inner;
    }
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const d = schema as z.ZodDefault<z.ZodTypeAny>;
      const inner = toJsonSchema(d._def.innerType);
      return { ...inner, default: d._def.defaultValue(), ...(schema.description ? { description: schema.description } : {}) };
    }
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return toJsonSchema((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
    default:
      throw new Error(`toJsonSchema: unsupported zod type ${def.typeName}`);
  }
}

/** Records every call so the turn result (and evals) can see which tools ran with what. */
export interface ToolCallLog {
  push(call: { name: string; input: unknown; result: string }): void;
}

/**
 * A runnable tool from a shared v3 schema. `run` returns the text the model sees; throw a `ToolError` for
 * a user-facing problem (sent back as is_error so the model explains it).
 */
export function defineTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<string>,
  calls?: ToolCallLog,
): BetaRunnableTool<z.infer<S>> {
  const fullDescription = schema.description ? `${description}\n${schema.description}` : description;
  return {
    type: "custom",
    name,
    description: fullDescription,
    input_schema: toJsonSchema(schema) as { type: "object"; [k: string]: unknown },
    parse: (content: unknown) => schema.parse(content) as z.infer<S>,
    run: async (input: z.infer<S>) => {
      let result: string;
      try {
        result = await run(input);
      } catch (err) {
        result = err instanceof ToolError ? `ERROR: ${err.message}` : `ERROR: internal error in ${name}`;
        if (!(err instanceof ToolError)) console.error(`[tool:${name}]`, err);
      }
      calls?.push({ name, input, result });
      return result;
    },
  };
}

/** A problem the model should explain to the user (unknown contact, over balance, …). */
export class ToolError extends Error {}
