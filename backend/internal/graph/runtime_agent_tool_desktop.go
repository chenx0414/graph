package graph

// The desktop capability is ONE tool.
//
// agent-desktop ships about sixty commands, and the obvious port would declare
// sixty tools: one per verb, each with its own schema. That is the opposite of
// what the tool surface needs - every declaration is paid for by every request
// of every session, and the provider-side budget counts characters, not verbs.
// The CLI is already the thing that validates its own arguments and answers with
// one JSON envelope, so the wrapper passes the verbs through as data and the
// model reads `--help` or the vendored skill instead of the schema.
//
// The description is the whole safety contract of the tool, in the order the
// model needs it: what it wraps, that the envelope comes back unchanged, that
// the default is headless, and that the payload is withheld unless asked for.
// Every clause is load-bearing and there is no room for a second sentence of
// prose.

const desktopToolDescription = "One agent-desktop command+args; envelope unchanged. Headless unless headed:true " +
	"(steals focus, moves the cursor). Output withheld unless include:output; repeat only when disposition.retry is \"safe\"."

// desktopPayloadKinds name what a withheld answer would have contained. It is
// the receipt's explanation, and the list is the one the privacy rule names: a
// window tree can hold a private message, a clipboard read can hold a password,
// and neither belongs in a transcript by accident. Every successful answer is
// withheld by default - the receipt is the default, `include: "output"` is the
// door - because the daemon stores tool results with the conversation.
var desktopPayloadKinds = map[string]string{
	"snapshot":             "the accessibility tree of a window",
	"find":                 "element names, values and text content",
	"get":                  "one element's text, value or title",
	"is":                   "one element's state",
	"screenshot":           "a PNG of an application window",
	"clipboard-get":        "the clipboard contents",
	"clipboard-set":        "the clipboard contents it wrote",
	"clipboard-clear":      "the clipboard it cleared",
	"batch":                "the output of every command in the batch, including the ones above",
	"trace":                "the recorded timeline of the session's actions",
	"list-windows":         "window titles",
	"list-apps":            "application names",
	"list-surfaces":        "surface titles",
	"list-notifications":   "notification text",
	"dismiss-notification": "notification text",
}

// desktopToolDeclarations is the computer-use surface: `command` plus `args`,
// and nothing else to keep in sync with the CLI's own command list.
func desktopToolDeclarations(set agentToolContext) []AgentToolDeclaration {
	return []AgentToolDeclaration{
		{
			Name: "desktop", Label: "Desktop control", Description: desktopToolDescription,
			Parameters: tbObject([]tbField{
				{"command", tbString(map[string]any{"description": "agent-desktop subcommand, e.g. snapshot, click, type, focus-window, clipboard-get, session. Pass --help as an arg to read the CLI's own help."})},
				{"args", tbOptional(tbArray(tbString(nil)))},
				{"headed", tbOptional(tbBool())},
				{"include", tbOptional(tbUnionLiteral([]string{"receipt", "output"}))},
			}, []string{"command"}),
			Available: set.features.Desktop,
		},
	}
}
