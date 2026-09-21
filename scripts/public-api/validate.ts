import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
	type ApiResource,
	exampleDirectory,
	findResource,
	groups,
	type ResourceGroup,
	schemaDirectory,
} from "./manifest";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = new Map<ApiResource, ValidateFunction>();

/** Validate a JSON value, after serializing the actual DTO as the endpoint does. */
export function assertPublicSchema(
	resource: ApiResource,
	payload: unknown,
): void {
	let validate = validators.get(resource);
	if (!validate) {
		const { group } = findResource(resource);
		const schema = JSON.parse(
			readFileSync(
				new URL(`${resource}.schema.json`, schemaDirectory(group)),
				"utf8",
			),
		);
		validate = ajv.compile(schema);
		validators.set(resource, validate);
	}
	if (!validate(payload))
		throw new Error(
			`${resource}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`,
		);
}

/** Example names start with their resource, followed optionally by a scenario. */
export async function validateExamplesFor(
	group: ResourceGroup,
): Promise<number> {
	const directory = exampleDirectory(group);
	let count = 0;
	const seen = new Set<string>();
	for (const filename of await readdir(directory)) {
		if (!filename.endsWith(".json")) continue;
		const resource = Object.keys(group.resources).find(
			(key) => filename === `${key}.json` || filename.startsWith(`${key}.`),
		);
		if (!resource) throw new Error(`Unknown example resource: ${filename}`);
		assertPublicSchema(
			resource as ApiResource,
			JSON.parse(await readFile(new URL(filename, directory), "utf8")),
		);
		seen.add(resource);
		count++;
	}
	for (const resource of Object.keys(group.resources)) {
		if (!seen.has(resource))
			throw new Error(`Missing published API example: ${resource}`);
	}
	return count;
}

export async function validateExamples(): Promise<number> {
	let count = 0;
	for (const group of Object.values(groups))
		count += await validateExamplesFor(group);
	return count;
}

if (import.meta.main)
	console.log(`Validated ${await validateExamples()} published API examples.`);
