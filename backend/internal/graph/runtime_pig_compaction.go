package graph

// pigCompactionInstructions is what the summarizer is told when the kernel compacts.
//
// A summary that does not say where the earlier conversation went leaves the next turn
// believing it was lost: the transcript is durable and searchable, so the summary says so and
// names the tool that reads it. The reset path already hands over that pointer; the summary
// that replaces the context has to carry it too.
func pigCompactionInstructions() string {
	return "Summarize this conversation so the work can continue from the summary alone. " +
		"Keep it short: what the user asked for, decisions taken, files and commands that matter, " +
		"what is still open. End with one sentence saying that the earlier conversation is " +
		"preserved in full in the durable transcript and can be searched with the " + historyToolNameGraph +
		" tool, by keyword or one entry by id."
}

const historyToolNameGraph = "history_search"
