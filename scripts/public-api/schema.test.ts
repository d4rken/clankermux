import {describe,expect,it} from "bun:test";
import {readFile} from "node:fs/promises";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import {toDraft2020,writeOrCheckSchemas} from "./generate";
import {assertPublicSchema,exampleDirectory,validateExamples} from "./validate";
import {resources} from "./manifest";
const example=async(name:string)=>JSON.parse(await readFile(new URL(`${name}.json`,exampleDirectory),"utf8"));
describe("replacement public schemas",()=>{
 it("reproduces the five contracts",async()=>{await writeOrCheckSchemas(true);},30000);
 it("validates every published example",async()=>{expect(await validateExamples()).toBeGreaterThanOrEqual(5);});
 it("requires the replacement fields and accepts future additions",async()=>{
  const a=await example("accounts");
  a.accounts[0].windows[0].forecast.futureField=true;
  assertPublicSchema("accounts",a);
  delete a.accounts[0].windows[0].forecast;
  expect(()=>assertPublicSchema("accounts",a)).toThrow();
 });
 it("allows signed pace and rejects negative counts",async()=>{
  const w=await example("workloads");
  w.workloads[0].weekly.pace.changePct=-25;
  assertPublicSchema("workloads",w);
  w.workloads[0].weekly.coverage.modeledAccounts=-1;
  expect(()=>assertPublicSchema("workloads",w)).toThrow();
 });
 it("pins each resource identifier",async()=>{
  for(const r of Object.keys(resources) as (keyof typeof resources)[]) {
   const p=await example(r==="stream" ? "stream.snapshot":r);p.schema="invalid";
   expect(()=>assertPublicSchema(r,p)).toThrow();
  }
 });
	it("preserves reference, tuple and dependency validation semantics", () => {
		const source = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			definitions: { identifier: { type: "string" } },
			properties: {
				id: { $ref: "#/definitions/identifier" },
				name: { type: "string" },
				pair: {
					type: "array",
					items: [{ type: "string" }, { type: "number" }],
					additionalItems: false,
				},
			},
			dependencies: {
				id: ["name"],
				pair: { properties: { id: { const: "known" } }, required: ["id"] },
			},
		};
		const converted = toDraft2020(source) as Record<string, unknown>;
		expect(converted).toHaveProperty("$defs");
		expect(converted).not.toHaveProperty("definitions");
		expect(converted).toHaveProperty("dependentRequired");
		expect(converted).toHaveProperty("dependentSchemas");
		const oldValidator = new Ajv({ strict: false }).compile(source);
		const newValidator = new Ajv2020({ strict: false }).compile(converted);
		const samples = [
			{},
			{ id: "known", name: "sample", pair: ["x", 2] },
			{ id: "known" },
			{ id: "known", name: "sample", pair: ["x", 2, 3] },
			{ id: "wrong", name: "sample", pair: ["x", 2] },
			{ id: "known", name: "sample", pair: [1, "x"] },
		];
		for (const sample of samples)
			expect(newValidator(sample)).toBe(oldValidator(sample));
	});
});
