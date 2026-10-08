import { expect, it } from "vitest";
import { startScheduledWorkflow } from "../../src/lifecycle/cron";

it("refuses invalid provider IDs before creating an instance", async () => {
  const created: string[] = [];
  const workflow = { create: async ({ id }: { id: string }) => { created.push(id); return { id }; } } as unknown as Workflow;
  for (const id of ["", "has:colon", "has/slash", "has.dot", "x".repeat(101)]) await expect(startScheduledWorkflow(workflow, id)).rejects.toThrow(/ID/);
  expect(created).toEqual([]);
  expect(await startScheduledWorkflow(workflow, "x".repeat(100))).toBe("x".repeat(100));
  expect(created).toEqual(["x".repeat(100)]);
});
it("keeps the original create failure when a returned handle cannot confirm an existing instance", async () => {
  const failure = new Error("Provider create unavailable");
  const workflow = { create: async () => { throw failure; }, get: async () => ({ status: async () => { throw new Error("Missing instance"); } }) } as unknown as Workflow;
  await expect(startScheduledWorkflow(workflow, "synthetic-discovery-2026-11-01-0130")).rejects.toBe(failure);
});
