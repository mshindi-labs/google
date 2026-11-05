import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryStore,
  runStoreContractTests,
} from "../../src/testing/index.js";

runStoreContractTests("InMemoryStore", async () => new InMemoryStore(), {
  describe,
  it,
  expect,
  beforeEach,
});
