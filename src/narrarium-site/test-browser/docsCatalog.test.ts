import { expect, test } from "vitest";
import { appDocEntries } from "@/lib/appDocs";
import { withGeneratedDocs } from "@/lib/docs";
import { docEntries } from "@/lib/generated-docs";

test("every repository document stays reachable next to the in-app guides", () => {
  const curated = new Set(appDocEntries.map((entry) => entry.slug));
  expect(docEntries.filter((entry) => curated.has(entry.slug)).map((entry) => entry.sourcePath)).toEqual([]);
});

test("curated docs override duplicate generated slugs while unique generated docs remain available", () => {
  const curated = appDocEntries[0];
  const generatedDuplicate = { ...curated, title: "Generated duplicate", sourcePath: "generated:duplicate" };
  const generatedUnique = { ...curated, title: "Generated unique", slug: "generated-unique", sourcePath: "generated:unique" };

  const merged = withGeneratedDocs([generatedDuplicate, generatedUnique]);

  expect(merged.filter((entry) => entry.slug === curated.slug)).toEqual([curated]);
  expect(merged.find((entry) => entry.slug === generatedUnique.slug)).toBe(generatedUnique);
});
