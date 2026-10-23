package graph

func (k *KernelStore) ModuleInput(taskID, moduleID, name string) *ModuleInputRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_module_inputs WHERE task_id=? AND module_id=? AND name=?", taskID, moduleID, name)
	if !ok {
		return nil
	}
	var value any
	if row["value"] != nil {
		value = k.Content.Decode(g5Str(row["value"]))
	}
	var source *string
	if row["source"] != nil {
		text := g5Str(row["source"])
		source = &text
	}
	return &ModuleInputRow{ModuleId: moduleID, Name: g5Str(row["name"]), Delivered: g5Int(row["delivered"]) == 1, Value: value, Source: source, UpdatedAt: g5Int(row["updated_at"])}
}

// SetModuleInput records the latest accepted delivery for one input.
func (k *KernelStore) SetModuleInput(taskID, moduleID, name string, value any, source *string) {
	k.ModuleTransaction(func() any {
		k.setModuleInputInTransaction(taskID, moduleID, name, value, source)
		return nil
	})
}
func (k *KernelStore) setModuleInputInTransaction(taskID, moduleID, name string, value any, source *string) {
	var stored any
	if source != nil {
		stored = *source
	}
	g5Exec(k.Db, `INSERT INTO kernel_module_inputs(task_id,module_id,name,delivered,value,source,updated_at) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(task_id,module_id,name) DO UPDATE SET delivered=1, value=excluded.value, source=excluded.source, updated_at=excluded.updated_at`, taskID, moduleID, name, k.Content.Encode(value), stored, NowMillis())
}

// RecordModuleTransition stores one judgment and its outbox row.
func (k *KernelStore) RecordModuleTransition(taskID string, input ModuleTransitionInput) ModuleTransitionRow {
	id := graphUUID()
	createdAt := NowMillis()
	k.ModuleTransaction(func() any {
		var verdict any
		if input.Verdict != nil {
			verdict = *input.Verdict
		}
		g5Exec(k.Db, "INSERT INTO kernel_module_transitions(id,task_id,module_id,input_name,input_value,state_before,state_after,verdict,outputs,rule_version,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, input.ModuleId, input.InputName, k.Content.Encode(input.InputValue), k.Content.Encode(input.StateBefore), k.Content.Encode(input.StateAfter), verdict, k.Content.Encode(input.Outputs), input.RuleVersion, input.Reason, createdAt)
		routed := 0
		if len(input.Outputs) == 0 {
			routed = 1
		}
		g5Exec(k.Db, "INSERT INTO kernel_transition_outbox(transition_id,routed) VALUES(?,?)", id, routed)
		triggered := 0
		if input.Verdict != nil {
			triggered = 1
		}
		g5Exec(k.Db, "UPDATE kernel_modules SET state=?, rule_version=?, triggered=CASE WHEN ?=1 THEN 1 ELSE triggered END WHERE task_id=? AND module_id=?", k.Content.Encode(input.StateAfter), input.RuleVersion, triggered, taskID, input.ModuleId)
		return nil
	})
	return ModuleTransitionRow{ModuleTransitionInput: input, Id: id, CreatedAt: createdAt}
}

// ModuleTransitions lists judgments in creation order.
func (k *KernelStore) ModuleTransitions(taskID, moduleID string) []ModuleTransitionRow {
	rows := g5Query(k.Db, "SELECT * FROM kernel_module_transitions WHERE task_id=? AND module_id=? ORDER BY created_at", taskID, moduleID)
	out := make([]ModuleTransitionRow, 0, len(rows))
	for _, row := range rows {
		var verdict *string
		if row["verdict"] != nil {
			text := g5Str(row["verdict"])
			verdict = &text
		}
		outputs, _ := k.Content.Decode(g5Str(row["outputs"])).(map[string]any)
		if outputs == nil {
			outputs = map[string]any{}
		}
		out = append(out, ModuleTransitionRow{
			Id: g5Str(row["id"]), CreatedAt: g5Int(row["created_at"]),
			ModuleTransitionInput: ModuleTransitionInput{
				ModuleId: moduleID, InputName: g5Str(row["input_name"]), InputValue: k.Content.Decode(g5Str(row["input_value"])),
				StateBefore: k.Content.Decode(g5Str(row["state_before"])), StateAfter: k.Content.Decode(g5Str(row["state_after"])),
				Verdict: verdict, Outputs: outputs, RuleVersion: int(g5Int(row["rule_version"])), Reason: g5Str(row["reason"]),
			},
		})
	}
	return out
}
