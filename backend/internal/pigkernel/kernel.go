package pigkernel

import (
	"context"
	"fmt"

	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
	pigsqlite "github.com/MichaelKinsy/PiG/durable/storage/sqlite"
)

// DurablePrefix namespaces every durable table and index inside the formal
// Graph database.
//
// The TypeScript kernel reached the same tables by rewriting SQL identifiers on
// the way in. PiG's SQLite port takes the prefix directly, so the kernel and
// the daemon address the same physical tables without a rewriting layer: an
// existing database keeps its history, and a database the kernel opens first
// is readable by the same names.
const DurablePrefix = "graph_durable_"

// Kernel is the PiG durable harness over one Graph database.
//
// The harness owns the durable conversation, task and document runtime: one
// session per Graph database, with the model and tool calls the Graph policy
// admits. The daemon keeps every business fact, credential and budget rule; the
// kernel keeps the execution history.
type Kernel struct {
	database *sqliteDatabase
	storage  *pigsqlite.SqliteStorage
	harness  harness.Harness
}

// Options configure the kernel.
type Options struct {
	// Database is the path of the formal Graph SQLite database.
	Database string
	// Models is the pi-ai model access the harness generates with. The Graph
	// daemon supplies it so credentials stay in the daemon.
	Models durable.Models
	// Registry holds the extensions and tools the harness offers.
	Registry harness.Registry
	// Settings resolve the harness policy at every use.
	Settings func() *harness.HarnessSettings
}

// Open opens the kernel over one Graph database.
//
// The database is opened with its own connection: the daemon's connection
// belongs to the daemon, and closing the kernel must never close it. The
// durable schema is created or upgraded in place, so the kernel can take over
// a database the TypeScript kernel wrote.
func Open(ctx context.Context, options Options) (*Kernel, error) {
	database, err := openSqliteDatabase(options.Database)
	if err != nil {
		return nil, fmt.Errorf("pig kernel: open %s: %w", options.Database, err)
	}
	prefix := DurablePrefix
	storage, err := pigsqlite.Open(database, pigsqlite.SqliteStorageOptions{Prefix: &prefix})
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("pig kernel: durable storage: %w", err)
	}
	opened, err := harness.OpenHarness(ctx, storage, harness.HarnessOptions{
		Models:   options.Models,
		Registry: options.Registry,
		Settings: options.Settings,
	})
	if err != nil {
		_ = storage.Close(ctx)
		_ = database.Close()
		return nil, fmt.Errorf("pig kernel: harness: %w", err)
	}
	return &Kernel{database: database, storage: storage, harness: opened}, nil
}

// Harness is the durable harness behind the kernel.
func (kernel *Kernel) Harness() harness.Harness { return kernel.harness }

// Storage is the durable storage behind the kernel.
func (kernel *Kernel) Storage() durable.Storage { return kernel.storage }

// DurableSchemaVersion is the version of the durable schema in the database.
//
// The TypeScript kernel wrote version 1. PiG ships version 2, so a database
// that reports 2 has been opened by the PiG kernel and migrated in place.
func DurableSchemaVersion(ctx context.Context, kernel *Kernel) (int, error) {
	row, err := kernel.database.Get("SELECT version FROM " + DurablePrefix + "durable_schema WHERE singleton = 1")
	if err != nil {
		return 0, fmt.Errorf("pig kernel: durable schema version: %w", err)
	}
	if row == nil {
		return 0, fmt.Errorf("pig kernel: durable schema metadata is missing")
	}
	version, ok := row["version"].(int64)
	if !ok {
		return 0, fmt.Errorf("pig kernel: durable schema version is not a number")
	}
	return int(version), nil
}

// Close ends the harness and releases the kernel's own connection.
func (kernel *Kernel) Close() error {
	ctx := context.Background()
	if kernel.harness != nil {
		kernel.harness.Close(ctx)
	}
	if kernel.storage != nil {
		if err := kernel.storage.Close(ctx); err != nil {
			return err
		}
	}
	if kernel.database != nil {
		return kernel.database.Close()
	}
	return nil
}
