package main

// collabMessage reports whether the message comes from another agent (a project
// supervisor, a peer or a sub-agent) rather than from the user. Those messages
// travel through the same conversation so the master agent can answer them, but
// they are internal cooperation, not something the user said.
func collabMessage(message transcriptMessage) bool {
	switch message.Data.Source.Kind {
	case "agent", "supervisor", "peer":
		return true
	}
	return false
}

// splitCollabMessages splits the transcript into what the user said (and the
// assistant answered) and the agent to agent messages the collaboration card
// owns.
func splitCollabMessages(messages []transcriptMessage) (spoken, collab []transcriptMessage) {
	for _, message := range messages {
		if collabMessage(message) {
			collab = append(collab, message)
			continue
		}
		spoken = append(spoken, message)
	}
	return spoken, collab
}
