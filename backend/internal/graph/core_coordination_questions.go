package graph

import "strings"

func (runtime *TaskRuntime) escalateQuestionToGlobal(row map[string]any, explanation string) {
	global := kernelRow(runtime.store.Db, "SELECT anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL")
	if global == nil {
		Raise("invalid_state", "The global supervisor is unavailable")
	}
	id := kernelString(row["id"])
	data := questionParseRecord(kernelString(row["data"]))
	data["projectReview"] = explanation
	runtime.store.SetQuestionHandler(id, "global", QuestionOwnerMain, data)
	revision := kernelInt(kernelRow(runtime.store.Db, "SELECT route_revision FROM questions WHERE id=?", id)["route_revision"])
	WakeMaster(runtime.store, WakeIntent{TaskID: kernelString(global["anchor_task_id"]), Kind: "supervisor_question", DedupeKey: id + ":" + itoa(int(revision)), Data: map[string]any{"questionId": id, "revision": revision}, HasData: true})
	runtime.store.Event(kernelString(row["task_id"]), "problem.escalated_global", map[string]any{"questionId": id, "revision": revision})
}

func (runtime *TaskRuntime) returnNodeQuestionToProject(row map[string]any, answer string) {
	id := kernelString(row["id"])
	taskID := kernelString(row["task_id"])
	data := questionParseRecord(kernelString(row["data"]))
	data["globalAnswer"] = answer
	runtime.store.SetQuestionHandler(id, "project", QuestionOwnerMain, data)
	revision := kernelInt(kernelRow(runtime.store.Db, "SELECT route_revision FROM questions WHERE id=?", id)["route_revision"])
	WakeMaster(runtime.store, WakeIntent{TaskID: taskID, Kind: "supervisor_question", DedupeKey: id + ":" + itoa(int(revision)), Data: map[string]any{"questionId": id, "revision": revision}, HasData: true})
	runtime.store.Event(taskID, "problem.returned_project", map[string]any{"questionId": id, "revision": revision})
}

func (runtime *TaskRuntime) answerProjectNodeQuestion(row map[string]any, action string, answer Answer) map[string]any {
	if action != "respond" {
		Raise("invalid_answer", "A node question requires a response or escalation")
	}
	id, taskID := kernelString(row["id"]), kernelString(row["task_id"])
	runtime.kernel.AnswerNodeQuestion(id, answer)
	return map[string]any{"questionId": id, "taskId": taskID, "action": action, "resolved": true}
}

func (runtime *TaskRuntime) escalateRoutedQuestion(row map[string]any, prompt string) {
	data := questionParseRecord(kernelString(row["data"]))
	data["supervisorRequestType"] = data["requestType"]
	data["supervisorPrompt"] = data["prompt"]
	data["supervisorWhy"] = data["why"]
	data["supervisorOptions"] = data["options"]
	data["supervisorMultiple"] = data["multiple"]
	data["requestType"] = "user_decision"
	data["prompt"] = prompt
	data["why"] = "The global supervisor needs your decision to answer the project supervisor."
	data["options"] = []string{}
	data["multiple"] = false
	id := kernelString(row["id"])
	runtime.store.SetQuestionHandler(id, "user", QuestionOwnerUser, data)
	OpenUserWait(runtime.store, kernelString(row["task_id"]), kernelString(row["node_id"]))
	runtime.store.Event(kernelString(row["task_id"]), "problem.escalated_user", map[string]any{"questionId": id, "prompt": prompt})
}

func (runtime *TaskRuntime) receiveRoutedUserAnswer(taskID, questionID string, answer Answer) bool {
	row := kernelRow(runtime.store.Db, "SELECT id,node_id,data FROM questions WHERE id=? AND task_id=? AND route_stage='user' AND status='open'", questionID, taskID)
	if row == nil {
		return false
	}
	if answer.Type != "respond" || answer.Value == nil || strings.TrimSpace(jsString(answer.Value)) == "" {
		Raise("invalid_answer", "A response is required")
	}
	global := kernelRow(runtime.store.Db, "SELECT anchor_task_id FROM conversations WHERE role='global' AND archived_at IS NULL")
	if global == nil {
		Raise("invalid_state", "The global supervisor is unavailable")
	}
	data := questionParseRecord(kernelString(row["data"]))
	data["userAnswer"] = answer.Value
	data["requestType"] = data["supervisorRequestType"]
	data["prompt"] = data["supervisorPrompt"]
	data["why"] = data["supervisorWhy"]
	data["options"] = data["supervisorOptions"]
	data["multiple"] = data["supervisorMultiple"]
	runtime.store.SetQuestionHandler(questionID, "global", QuestionOwnerMain, data)
	CloseUserWait(runtime.store, taskID, kernelString(row["node_id"]))
	revision := kernelInt(kernelRow(runtime.store.Db, "SELECT route_revision FROM questions WHERE id=?", questionID)["route_revision"])
	WakeMaster(runtime.store, WakeIntent{TaskID: kernelString(global["anchor_task_id"]), Kind: "supervisor_question", DedupeKey: questionID + ":" + itoa(int(revision)), Data: map[string]any{"questionId": questionID, "revision": revision}, HasData: true})
	runtime.store.Event(taskID, "problem.user_answered", map[string]any{"questionId": questionID, "revision": revision})
	return true
}
