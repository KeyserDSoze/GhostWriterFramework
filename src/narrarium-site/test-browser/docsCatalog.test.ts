import { expect, test } from "vitest";
import { appDocEntries } from "@/lib/appDocs";
import { withGeneratedDocs } from "@/lib/docs";

test("curated docs override duplicate generated slugs while unique generated docs remain available", () => {
  const curated = appDocEntries[0];
  const generatedDuplicate = { ...curated, title: "Generated duplicate", sourcePath: "generated:duplicate" };
  const generatedUnique = { ...curated, title: "Generated unique", slug: "generated-unique", sourcePath: "generated:unique" };

  const merged = withGeneratedDocs([generatedDuplicate, generatedUnique]);

  expect(merged.filter((entry) => entry.slug === curated.slug)).toEqual([curated]);
  expect(merged.find((entry) => entry.slug === generatedUnique.slug)).toBe(generatedUnique);
});
