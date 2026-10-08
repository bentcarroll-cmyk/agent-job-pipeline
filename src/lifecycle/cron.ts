/** Create exactly one durable calendar instance. Only a confirmed existing instance
 * makes a duplicate delivery successful; a provider outage remains an error. */
export async function startScheduledWorkflow(workflow: Workflow, id: string): Promise<string> {
  if (id.length > 100 || !/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/.test(id)) throw new Error("Invalid scheduled Workflow ID");
  try { return (await workflow.create({ id })).id; }
  catch (error) {
    try { await (await workflow.get(id)).status(); }
    catch { throw error; }
    return id;
  }
}
