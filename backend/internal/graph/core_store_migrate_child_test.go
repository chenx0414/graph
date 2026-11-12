// graph:table-writes-exempt: the test seeds the rows the constraint reads
package graph

import (
	"path/filepath"
	"testing"
)

func TestConversationsAllowChildRoleAfterMigration(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "child-role.sqlite"))
	defer store.Close()
	if _, err := store.DB.Exec(`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
		VALUES('child-1','workspace','task-1','child agent',1,0,'child')`); err != nil {
		t.Fatalf("a child agent conversation must be allowed: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,project_id,role)
		VALUES('global-1','workspace','task-2','global',2,0,'project','global')`); err == nil {
		t.Fatal("a global supervisor must still be refused a project binding")
	}
}
