import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { configure } from "@testing-library/react";
import { afterAll } from "vitest";
import { resetCloudWriteBarrierForTests } from "@/drive/cloudWriteBarrier";

// Waits end as soon as their condition holds; a generous limit only matters on a busy machine (coverage, parallel workers),
// where the default second is too short for flows that go through IndexedDB and several async steps.
configure({ asyncUtilTimeout: 4000 });

afterAll(() => resetCloudWriteBarrierForTests());
