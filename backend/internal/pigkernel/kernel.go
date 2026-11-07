package pigkernel

import (
	"context"
	"fmt"

	"github.com/MichaelKinsy/PiG/durable"
	"github.com/MichaelKinsy/PiG/durable/harness"
	pigsqlite "github.com/MichaelKinsy/PiG/durable/storage/sqlite"
)

const DurablePrefix = "graph_durable_"

type Kernel struct {
	database *sqliteDatabase
	storage  *pigsqlite.SqliteStorage
	harness  harness.Harness
}

type Options struct {
	Database string
	Models durable.Models
	Registry harness.Registry
	Settings func() *harness.HarnessSettings
}

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

func (kernel *Kernel) Harness() harness.Harness { return kernel.harness }

func (kernel *Kernel) Storage() durable.Storage { return kernel.storage }

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
