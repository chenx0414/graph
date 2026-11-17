// graph:table-writes-exempt: a test seeds the messages it quotes
package graph

import (
	"testing"
)

func quoteFixture(t *testing.T) *TaskStore {
	t.Helper()
	store := routeFixture(t)
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,state,text,seq,turn,created_at,updated_at)
		VALUES('m-user','c-proj','user','chat','done','放行阶段一',1,1,1000,1000)`)
	kernelExec(store.DB, `INSERT INTO messages(id,conversation_id,role,kind,state,text,data,seq,turn,created_at,updated_at)
		VALUES('m-agent','c-proj','user','chat','done','[来自全局主管的确认] 放行阶段一','{"source":{"kind":"agent"}}',2,1,2000,2000)`)
	return store
}

func TestAConfirmationQuotesAMessageRecordedInTheConversation(t *testing.T) {
	store := quoteFixture(t)
	if !confirmationQuoted(store, "t-proj", "放行阶段一") {
		t.Fatal("a message recorded in the conversation has to authorise the confirmation")
	}
	if !confirmationQuoted(store, "t-proj", "全局主管的确认") {
		t.Fatal("a confirmation relayed by the global supervisor has to authorise too: the project supervisor can only quote the words that reached it")
	}
	if !confirmationQuoted(store, "t-proj", "放行") {
		t.Fatal("a quoted fragment has to authorise as well, the supervisor quotes the words that were used")
	}
}

func TestAConfirmationFromAnotherConversationOrOfNothingIsRefused(t *testing.T) {
	store := quoteFixture(t)
	if confirmationQuoted(store, "t-proj", "用户从没说过这句话") {
		t.Fatal("a quote that matches no recorded message must not authorise anything")
	}
	if confirmationQuoted(store, "t-global", "放行阶段一") {
		t.Fatal("the quote has to come from the conversation that confirms, not from a sibling")
	}
	if confirmationQuoted(store, "t-proj", "  ") {
		t.Fatal("an empty instruction authorises nothing")
	}
}
