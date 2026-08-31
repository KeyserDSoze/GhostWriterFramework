import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { afterAll } from "vitest";
import { resetCloudWriteBarrierForTests } from "@/drive/cloudWriteBarrier";

afterAll(() => resetCloudWriteBarrierForTests());
