package graph

// The prompt a node was actually sent.
//
// The lane recorded it with SQL of its own, in two places that each had
// the same insert written out. The store owns the table, so the store
// records it.

// RecordPrompt stores the prompt and the tool list a node was sent with.
func (k *KernelStore) RecordPrompt(taskID, nodeID, executionID, systemPrompt, tools string) {
	g5Exec(k.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
		taskID, nodeID, executionID, systemPrompt, tools, NowMillis())
}
