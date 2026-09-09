import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";
import {
	countFields,
	type PublicResource,
	resources,
} from "./manifest";

export type Schema = { [key: string]: unknown };
export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const schemaDirectory = new URL(
	"../../docs/public-api/schemas/",
	import.meta.url,
);

function isObject(value: unknown): value is Schema {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The generator emits Draft 7. Convert its semantic differences, not just the
 * dialect label: definitions/refs, tuple items, and dependencies. These schemas
 * currently need only definitions/refs; tests cover the other transformations.
 */
export function toDraft2020(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toDraft2020);
	if (!isObject(value)) return value;
	const result: Schema = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "$schema") continue;
		if (key === "definitions") result.$defs = toDraft2020(child);
		else if (key === "$ref" && typeof child === "string") {
			result.$ref = child.replace(/^#\/definitions\//, "#/$defs/");
		} else if (key === "items" && Array.isArray(child)) {
			result.prefixItems = toDraft2020(child);
			result.items = toDraft2020(value.additionalItems ?? true);
		} else if (key === "additionalItems") {
			// Draft 7 ignores this keyword for non-tuples, as does this conversion.
		} else if (key === "dependencies" && isObject(child)) {
			for (const [name, dependency] of Object.entries(child)) {
				const target = Array.isArray(dependency)
					? "dependentRequired"
					: "dependentSchemas";
				result[target] ??= {};
				const entries = result[target] as Schema;
				entries[name] = toDraft2020(dependency);
			}
		} else result[key] = toDraft2020(child);
	}
	return result;
}

/** Apply constraints to primitive branches without making nullable types non-null. */
function constrain(
	schema: Schema,
	primitive: string,
	constraints: Schema,
): void {
	const wasUnion = Array.isArray(schema.type);
	const types = wasUnion ? (schema.type as unknown[]) : [schema.type];
	if (types.includes(primitive)) {
		Object.assign(schema, constraints);
		if (constraints.type && wasUnion) {
			schema.type = types.map((type) =>
				type === primitive ? constraints.type : type,
			);
		}
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(schema[key])) {
			for (const part of schema[key])
				if (isObject(part)) constrain(part, primitive, constraints);
		}
	}
}

function addWireConstraints(schema: Schema, resource: PublicResource): void {
	if (schema.type === "object" || isObject(schema.properties))
		schema.additionalProperties = true;
	if (isObject(schema.properties)) {
		for (const [key, property] of Object.entries(schema.properties)) {
			if (!isObject(property)) continue;
			if (key === "schema") property.const = resources[resource].id;
			if (key.endsWith("At") || key === "at" || key === "until") {
				constrain(property, "string", { format: "date-time" });
			}
			if (key.endsWith("Count") || countFields.has(key)) {
				constrain(property, "number", { type: "integer", minimum: 0 });
			} else if (
				key.endsWith("Ms") ||
				key === "uptimeS" ||
				(key.endsWith("Pct") && key !== "changePct") ||
				key === "burnRatio" ||
				key === "costUsd"
			) {
				constrain(property, "number", { minimum: 0 });
			}
		}
	}
	for (const child of Object.values(schema)) {
		if (Array.isArray(child)) {
			for (const part of child)
				if (isObject(part)) addWireConstraints(part, resource);
		} else if (isObject(child)) addWireConstraints(child, resource);
	}
}

export function generateSchemas(): Record<PublicResource, Schema> {
	const generator = createGenerator({
		path: `${projectRoot}packages/http-api/src/handlers/public/dto.ts`,
		tsconfig: `${projectRoot}tsconfig.json`,
		type: Object.values(resources).map((resource) => resource.type),
		skipTypeCheck: true, // Repository typecheck remains the authority; avoid generator's bundled TS version.
		additionalProperties: true,
	});
	return Object.fromEntries(
		Object.entries(resources).map(([name, entry]) => {
			const resource = name as PublicResource;
			const schema = toDraft2020(generator.createSchema(entry.type)) as Schema;
			schema.$schema = "https://json-schema.org/draft/2020-12/schema";
			schema.$id = `urn:clankermux:${entry.id.replace(/^clankermux\./, "")}`;
			schema.$comment =
				"Generated from public DTOs. Unknown properties are accepted; producer allowlist tests enforce privacy. This is the replacement public contract.";
			addWireConstraints(schema, resource);
			return [resource, schema];
		}),
	) as Record<PublicResource, Schema>;
}

export function serializeSchema(schema: Schema): string {
	return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function writeOrCheckSchemas(check: boolean): Promise<void> {
	const schemas = generateSchemas();
	if (!check) await mkdir(schemaDirectory, { recursive: true });
	for (const [resource, schema] of Object.entries(schemas)) {
		const path = new URL(`${resource}.schema.json`, schemaDirectory);
		const expected = serializeSchema(schema);
		if (check) {
			if ((await readFile(path, "utf8")) !== expected)
				throw new Error(
					`Schema drift: ${resource}; run bun run public-api:generate`,
				);
		} else await writeFile(path, expected);
	}
}

if (import.meta.main) {
	await writeOrCheckSchemas(process.argv.includes("--check"));
	console.log(
		process.argv.includes("--check")
			? "Public API schemas are current."
			: "Generated five public API schemas.",
	);
}
