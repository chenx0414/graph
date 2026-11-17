package graph

import (
	"fmt"
	"strings"
)

func conversationsVersion(store *TaskStore) string {
	rows := kernelRows(store.Db, `SELECT id, role, COALESCE(title,'') AS title,
       COALESCE(archived_at,0) AS archivedAt, COALESCE(project_id,'') AS projectId
    FROM conversations WHERE role!='child' ORDER BY id`)
	parts := make([]string, 0, len(rows))
	for _, row := range rows {
		parts = append(parts, fmt.Sprintf("%s|%s|%s|%d|%s",
			kernelString(row["id"]), kernelString(row["role"]), kernelString(row["title"]),
			kernelInt(row["archivedAt"]), kernelString(row["projectId"])))
	}
	return fmt.Sprintf("%d:%s", len(rows), strings.Join(parts, "\n"))
}
