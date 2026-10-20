package graph

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// The PiG kernel takes over the durable namespace of a Graph database that the
// TypeScript kernel wrote. The takeover is only safe if both kernels address
// the same records, so the inspection below reads the real tables through
// PiG's own storage contract and reports what it found.
//
// It is a read-only surface: the harness is opened, the durable schema is
// brought up to the level PiG ships, and the records are reported. No Graph
// business fact is read or written through it.

// PigKernelConversation is one durable conversation the kernel found.
type PigKernelConversation struct {
	Id               int64 `json:"id"`
	OwnerConversation int64 `json:"ownerConversation"`
	OwnerTask        int64 `json:"ownerTask"`
	Entries          int   `json:"entries"`
}

// PigKernelReport is what the PiG kernel found in a Graph database.
type PigKernelReport struct {
	Database      string                  `json:"database"`
	Prefix        string                  `json:"prefix"`
	SchemaVersion int                     `json:"schemaVersion"`
	Conversations []PigKernelConversation `json:"conversations"`
	Submissions   int                     `json:"submissions"`
	Tasks         int                     `json:"tasks"`
}

// InspectPigKernel opens the PiG durable kernel over one Graph database and
// reports the durable records it finds there.
func InspectPigKernel(database string) (PigKernelReport, error) {
	ctx := context.Background()
	registry := harness.CreateRegistry()
	kernel, err := pigkernel.Open(ctx, pigkernel.Options{Database: database, Registry: registry})
	if err != nil {
		return PigKernelReport{}, err
	}
	defer func() { _ = kernel.Close() }()
	report := PigKernelReport{Database: database, Prefix: pigkernel.DurablePrefix}
	version, err := pigkernel.DurableSchemaVersion(ctx, kernel)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.SchemaVersion = version
	page, err := kernel.Storage().ScanConversations(ctx, durable.ConversationQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	for _, conversation := range page.Items {
		found := PigKernelConversation{Id: int64(conversation.Id)}
		if conversation.Owner != nil {
			found.OwnerConversation = int64(conversation.Owner.ConversationId)
			found.OwnerTask = int64(conversation.Owner.TaskId)
		}
		entries, err := kernel.Storage().ScanEntries(ctx, durable.EntryQuery{ConversationId: conversation.Id}, 1000, nil)
		if err != nil {
			return PigKernelReport{}, err
		}
		found.Entries = len(entries.Items)
		report.Conversations = append(report.Conversations, found)
	}
	submissions, err := kernel.Storage().ScanSubmissions(ctx, durable.SubmissionQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.Submissions = len(submissions.Items)
	tasks, err := kernel.Storage().ScanTasks(ctx, durable.TaskQuery{}, 1000, nil)
	if err != nil {
		return PigKernelReport{}, err
	}
	report.Tasks = len(tasks.Items)
	return report, nil
}

// PrintPigKernelReport writes the kernel report as one JSON line.
func PrintPigKernelReport(database string) error {
	report, err := InspectPigKernel(database)
	if err != nil {
		return err
	}
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}
