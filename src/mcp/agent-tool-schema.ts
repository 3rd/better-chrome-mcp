import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

type AgentToolSchema<Input extends object = object, Output extends object = Input> = StandardJSONSchemaV1<
  Input,
  Output
> &
  StandardSchemaV1<Input, Output>;

type AgentToolSchemaDirection = "input" | "output";

export type AgentToolConformanceOptions = {
  defaultPaths?: readonly string[];
  direction?: AgentToolSchemaDirection;
  mapPaths?: readonly string[];
  nullablePaths?: readonly string[];
  optionalPaths?: readonly string[];
};

type JsonSchemaRecord = Record<string, unknown>;

const advertisedSchemas = new WeakMap<object, Partial<Record<AgentToolSchemaDirection, StandardSchemaV1>>>();

const isRecord = (value: unknown): value is JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const schemaPath = (parent: string, segment: string): string =>
  parent === "$" ? `$.${segment}` : `${parent}.${segment}`;

const sortedUniqueStrings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
};

const schemaAllowsNull = (schema: JsonSchemaRecord): boolean => {
  if (schema.nullable === true || schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => isRecord(branch) && schemaAllowsNull(branch))) {
      return true;
    }
  }

  return false;
};

const schemaChildren = (schema: JsonSchemaRecord, path: string): [JsonSchemaRecord, string][] => {
  const children: [JsonSchemaRecord, string][] = [];
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties) {
    for (const [name, property] of Object.entries(properties)) {
      if (isRecord(property)) children.push([property, schemaPath(path, name)]);
    }
  }

  const items = schema.items;
  if (isRecord(items)) children.push([items, `${path}[]`]);

  const additionalProperties = schema.additionalProperties;
  if (isRecord(additionalProperties)) children.push([additionalProperties, `${path}{}`]);

  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      if (isRecord(branch)) children.push([branch, `${path}.${key}[${index}]`]);
    }
  }

  for (const key of ["$defs", "definitions"] as const) {
    const definitions = schema[key];
    if (!isRecord(definitions)) continue;
    for (const [name, definition] of Object.entries(definitions)) {
      if (isRecord(definition)) children.push([definition, `${path}.${key}.${name}`]);
    }
  }

  return children;
};

const assertClosedObject = (
  schema: JsonSchemaRecord,
  path: string,
  mapPaths: ReadonlySet<string>,
  optionalPaths: ReadonlySet<string>,
): boolean => {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const isObject =
    schema.type === "object" || properties !== undefined || schema.additionalProperties !== undefined;
  if (!isObject) return false;
  const hasComposition = (["allOf", "anyOf", "oneOf"] as const).some((key) => Array.isArray(schema[key]));
  const isCompositionWrapper =
    properties === undefined && schema.additionalProperties === undefined && hasComposition;
  if (isCompositionWrapper) return false;
  if (path === "$" && hasComposition) {
    if (schema.additionalProperties !== false) {
      throw new Error("Agent tool schema composition root must set additionalProperties to false");
    }
    return false;
  }

  const propertyNames = Object.keys(properties ?? {}).sort((left, right) => left.localeCompare(right));
  const isMap = mapPaths.has(path) || schema["x-agent-map"] === true;
  if (isMap) {
    if (propertyNames.length > 0 || !isRecord(schema.additionalProperties)) {
      throw new Error(
        `Agent tool schema map '${path}' must contain only a schema-valued additionalProperties field`,
      );
    }
    return true;
  }

  if (propertyNames.length === 0 && isRecord(schema.additionalProperties)) {
    throw new Error(`Agent tool schema map '${path}' must be declared explicitly`);
  }

  if (schema.additionalProperties !== false) {
    throw new Error(`Agent tool schema object '${path}' must set additionalProperties to false`);
  }

  const required = sortedUniqueStrings(schema.required);
  const requiredPropertyNames = propertyNames.filter((name) => !optionalPaths.has(schemaPath(path, name)));
  const hasExactRequired =
    requiredPropertyNames.length === 0 ?
      required === undefined || required.length === 0
    : required !== undefined &&
      required.length === requiredPropertyNames.length &&
      required.every((name, index) => name === requiredPropertyNames[index]);
  if (!hasExactRequired) {
    throw new Error(`Agent tool schema object '${path}' must require every declared property`);
  }

  return true;
};

const schemaFor = <Input extends object, Output extends object>(
  schema: AgentToolSchema<Input, Output>,
  direction: AgentToolSchemaDirection,
): JsonSchemaRecord => schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" });

const assertAgentToolJsonSchema = (
  schema: JsonSchemaRecord,
  options: AgentToolConformanceOptions = {},
): JsonSchemaRecord => {
  if (schema.type !== "object") {
    throw new Error("Agent tool schema root must serialize with type object");
  }
  if (
    (options.direction ?? "input") === "input" &&
    !isRecord(schema.properties) &&
    !isRecord(schema.additionalProperties)
  ) {
    throw new Error("Agent tool schema root must expose properties or schema-valued additionalProperties");
  }
  const mapPaths = new Set(options.mapPaths ?? []);
  const nullablePaths = new Set(options.nullablePaths ?? []);
  const defaultPaths = new Set(options.defaultPaths ?? []);
  const optionalPaths = new Set(options.optionalPaths ?? []);
  const pending: [JsonSchemaRecord, string][] = [[schema, "$"]];
  const nodes: [JsonSchemaRecord, string][] = [];
  let objectBranches = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes.push(current);
    pending.push(...schemaChildren(current[0], current[1]));
  }

  for (const [node, path] of nodes) {
    if (Object.hasOwn(node, "default") && !defaultPaths.has(path)) {
      throw new Error(`Agent tool schema '${path}' must represent defaults with an explicit branch`);
    }
  }

  for (const [node, path] of nodes) {
    const nullablePath = [...nullablePaths].some(
      (approved) =>
        path === approved || path.startsWith(`${approved}.anyOf[`) || path.startsWith(`${approved}.oneOf[`),
    );
    if (schemaAllowsNull(node) && !nullablePath) {
      throw new Error(
        `Agent tool schema '${path}' must represent absence or clearing with an explicit branch`,
      );
    }
  }

  for (const [node, path] of nodes) {
    if (assertClosedObject(node, path, mapPaths, optionalPaths)) objectBranches += 1;
  }

  if (objectBranches === 0) throw new Error("Agent tool schema must contain at least one object branch");
  return schema;
};

const runtimeGuidanceFor = (schema: JsonSchemaRecord): string[] => {
  const guidance: string[] = [];
  if (typeof schema["x-agent-runtime"] === "string") {
    const runtimeConstraint = schema["x-agent-runtime"].trim();
    if (runtimeConstraint) {
      guidance.push(/[!.?]$/.test(runtimeConstraint) ? runtimeConstraint : `${runtimeConstraint}.`);
    }
  }
  return guidance;
};

const unionBranches = (schema: JsonSchemaRecord): JsonSchemaRecord[] => {
  for (const key of ["oneOf", "anyOf"] as const) {
    const value = schema[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
};

const createDescription = (schema: JsonSchemaRecord, additions: string[]) => {
  const prose = typeof schema.description === "string" ? schema.description.trim() : "";
  return [prose, ...additions.map((addition) => addition.trim()).filter(Boolean)].filter(Boolean).join(" ");
};

const stripSafeIntegerSentinels = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  const transformValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(transformValue);
    if (isRecord(value)) return stripSafeIntegerSentinels(value);

    return value;
  };

  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => {
        if (schema.type !== "integer") return true;
        if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) return false;
        if (key === "minimum" && value === -Number.MAX_SAFE_INTEGER) return false;

        return true;
      })
      .map(([key, value]) => [key, transformValue(value)]),
  );
};

const LOCAL_DEFINITION_PREFIX = "#/$defs/";

const decodeJsonPointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const localDefinitionName = (node: JsonSchemaRecord): string | undefined => {
  const reference = node.$ref;
  if (typeof reference !== "string" || !reference.startsWith(LOCAL_DEFINITION_PREFIX)) return undefined;
  return decodeJsonPointerSegment(reference.slice(LOCAL_DEFINITION_PREFIX.length));
};

const referencedDefinitionNames = (node: unknown, names: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(node)) {
    for (const item of node) referencedDefinitionNames(item, names);
    return names;
  }
  if (!isRecord(node)) return names;
  const name = localDefinitionName(node);
  if (name !== undefined) names.add(name);
  for (const value of Object.values(node)) referencedDefinitionNames(value, names);
  return names;
};

const recursiveDefinitionNames = (definitions: JsonSchemaRecord): Set<string> => {
  const reachableDefinitionNames = (name: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [...referencedDefinitionNames(definitions[name])];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      pending.push(...referencedDefinitionNames(definitions[next]));
    }
    return visited;
  };
  return new Set(Object.keys(definitions).filter((name) => reachableDefinitionNames(name).has(name)));
};

const inlineLocalDefinitions = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  const definitions = isRecord(schema.$defs) ? schema.$defs : {};
  const recursive = recursiveDefinitionNames(definitions);
  const retained = new Set<string>();

  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!isRecord(node)) return node;

    const name = localDefinitionName(node);
    if (name !== undefined) {
      const definition = definitions[name];
      if (recursive.has(name) || !isRecord(definition)) {
        retained.add(name);
        return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value)]));
      }

      const resolved = resolve(definition);
      const siblings = Object.entries(node)
        .filter(([key]) => key !== "$ref")
        .map(([key, value]) => [key, resolve(value)]);
      return { ...(isRecord(resolved) ? resolved : {}), ...Object.fromEntries(siblings) };
    }

    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "$defs")
        .map(([key, value]) => [key, resolve(value)]),
    );
  };

  const inlined = resolve(schema);
  if (!isRecord(inlined)) throw new Error("Agent tool JSON Schema root must remain an object");
  if (retained.size === 0) return inlined;

  const retainedDefinitions = new Map<string, unknown>();
  while (retained.size > 0) {
    const pending = [...retained];
    retained.clear();
    for (const name of pending) {
      if (retainedDefinitions.has(name) || !isRecord(definitions[name])) {
        continue;
      }
      retainedDefinitions.set(name, resolve(definitions[name]));
    }
  }

  const orderedDefinitions = [...retainedDefinitions].sort(([left], [right]) => left.localeCompare(right));
  return { ...inlined, $defs: Object.fromEntries(orderedDefinitions) };
};

const renderAdvertisedJsonSchema = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  const cloned = stripSafeIntegerSentinels(inlineLocalDefinitions(schema));
  delete cloned.$schema;
  const pending: JsonSchemaRecord[] = [cloned];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (Array.isArray(node.oneOf) && node.anyOf === undefined) {
      node.anyOf = node.oneOf;
      delete node.oneOf;
    }

    const description = createDescription(node, runtimeGuidanceFor(node));
    if (description.length > 0) node.description = description;
    else delete node.description;

    const properties = isRecord(node.properties) ? node.properties : undefined;
    if (properties) {
      for (const property of Object.values(properties)) {
        if (isRecord(property)) pending.push(property);
      }
    }
    if (isRecord(node.items)) pending.push(node.items);
    if (isRecord(node.additionalProperties)) pending.push(node.additionalProperties);
    pending.push(...unionBranches(node));
    for (const key of ["$defs", "definitions"] as const) {
      const definitions = node[key];
      if (!isRecord(definitions)) continue;
      for (const definition of Object.values(definitions)) {
        if (isRecord(definition)) pending.push(definition);
      }
    }
  }
  return cloned;
};

export const assertAgentToolSchema = <Input extends object, Output extends object>(
  schema: AgentToolSchema<Input, Output>,
  options: AgentToolConformanceOptions = {},
): AgentToolSchema<Input, Output> => {
  const direction = options.direction ?? "input";
  assertAgentToolJsonSchema(schemaFor(schema, direction), options);
  const render = () => renderAdvertisedJsonSchema(schemaFor(schema, direction));
  const advertised: AgentToolSchema<Input, Output> = {
    "~standard": {
      ...schema["~standard"],
      jsonSchema: {
        input: render,
        output: render,
      },
    },
  };
  const variants = advertisedSchemas.get(schema) ?? {};
  variants[direction] = advertised;
  advertisedSchemas.set(schema, variants);
  return schema;
};

export const advertisedAgentToolJsonSchema = <Input extends object, Output extends object>(
  schema: AgentToolSchema<Input, Output>,
  direction: AgentToolSchemaDirection = "input",
): JsonSchemaRecord => renderAdvertisedJsonSchema(schemaFor(schema, direction));

export const advertisedAgentToolSchema = (
  schema: StandardSchemaV1,
  direction: AgentToolSchemaDirection,
): StandardSchemaV1 => {
  return advertisedSchemas.get(schema)?.[direction] ?? schema;
};
