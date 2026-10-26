package graph

// RecordPrompt stores the prompt and the tool list a node was sent with.
func (k *KernelStore) RecordPrompt(taskID, nodeID, executionID, systemPrompt, tools string) {
	g5Exec(k.Db, "INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)",
		taskID, nodeID, executionID, systemPrompt, tools, NowMillis())
}
