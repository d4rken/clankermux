import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { type PublicResource, resources } from "./manifest";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = new Map<PublicResource, ValidateFunction>();

/** Validate a JSON value, after serializing the actual DTO as the endpoint does. */
export function assertPublicSchema(
	resource: PublicResource,
	payload: unknown,
): void {
	let validate = validators.get(resource);
	if (!validate) {
		const schema = JSON.parse(
			readFileSync(
				new URL(
					`../../docs/public-api/schemas/${resource}.schema.json`,
					import.meta.url,
				),
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

export const exampleDirectory = new URL(
	"../../docs/public-api/examples/",
	import.meta.url,
);

/** Example names start with their resource, followed optionally by a scenario. */
export async function validateExamples(): Promise<number> {
	let count = 0;
	const seen = new Set<PublicResource>();
	for (const filename of await readdir(exampleDirectory)) {
		if (!filename.endsWith(".json")) continue;
		const resource = Object.keys(resources).find(
			(key) => filename === `${key}.json` || filename.startsWith(`${key}.`),
		) as PublicResource | undefined;
		if (!resource) throw new Error(`Unknown example resource: ${filename}`);
		assertPublicSchema(
			resource,
			JSON.parse(await readFile(new URL(filename, exampleDirectory), "utf8")),
		);
		seen.add(resource);
		count++;
	}
	for (const resource of Object.keys(resources) as PublicResource[]) {
		if (!seen.has(resource))
			throw new Error(`Missing public API example: ${resource}`);
	}
	return count;
}

if (import.meta.main)
	console.log(`Validated ${await validateExamples()} public API examples.`);
