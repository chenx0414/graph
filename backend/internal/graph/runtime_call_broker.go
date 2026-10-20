package graph

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// UsageSource describes where token counts came from.
type UsageSource string

const (
	UsageAuthoritative UsageSource = "authoritative"
	UsageAccountDelta  UsageSource = "account_delta"
	UsageEstimated     UsageSource = "estimated"
	UsageUnknown       UsageSource = "unknown"
)

// USAGE_SOURCES is the provenance vocabulary, strongest last in merge order is not this list order.
var USAGE_SOURCES = []UsageSource{UsageAuthoritative, UsageAccountDelta, UsageEstimated, UsageUnknown}

// TokenUsage is a disjoint token count. Reasoning is part of output.
type TokenUsage struct {
	Input       int64   `json:"input"`
	Output      int64   `json:"output"`
	CacheRead   int64   `json:"cacheRead"`
	CacheWrite  int64   `json:"cacheWrite"`
	UsageSource *string `json:"usageSource,omitempty"`
}

func isUsageSource(value string) bool {
	for _, source := range USAGE_SOURCES {
		if string(source) == value {
			return true
		}
	}
	return false
}

// UsageSourceOf normalizes missing provenance to authoritative and a missing usage to unknown.
func UsageSourceOf(usage *TokenUsage) UsageSource {
	if usage == nil {
		return UsageUnknown
	}
	if usage.UsageSource == nil {
		return UsageAuthoritative
	}
	if isUsageSource(*usage.UsageSource) {
		return UsageSource(*usage.UsageSource)
	}
	return UsageUnknown
}

// NormalizeTokenUsage copies usage with a concrete provenance.
func NormalizeTokenUsage(usage TokenUsage) TokenUsage {
	source := string(UsageSourceOf(&usage))
	usage.UsageSource = &source
	return usage
}

// MergeUsageSource picks the weaker provenance. Unknown beats every other source.
func MergeUsageSource(current, next UsageSource) UsageSource {
	if current == UsageUnknown || next == UsageUnknown {
		return UsageUnknown
	}
	if current == UsageEstimated || next == UsageEstimated {
		return UsageEstimated
	}
	if current == UsageAccountDelta || next == UsageAccountDelta {
		return UsageAccountDelta
	}
	return UsageAuthoritative
}

// TokenUsageTotal sums the four disjoint counts.
func TokenUsageTotal(usage TokenUsage) int64 {
	return usage.Input + usage.Output + usage.CacheRead + usage.CacheWrite
}

// CallBrokerCall is one broker invocation row.
type CallBrokerCall struct {
	Id       string  `json:"id"`
	Reserved int64   `json:"reserved"`
	State    string  `json:"state"`
	Usage    *string `json:"usage"`
}

// CallBrokerInspect is the account plus every call.
type CallBrokerInspect struct {
	InstanceId string           `json:"instanceId"`
	Budget     int64            `json:"budget"`
	Used       int64            `json:"used"`
	Reserved   int64            `json:"reserved"`
	Hold       *string          `json:"hold"`
	Status     string           `json:"status"`
	Calls      []CallBrokerCall `json:"calls"`
}

// CallBroker is the single-owner token gate. Callbacks are trusted dispatch code.
type CallBroker struct {
	db   *sql.DB
	conn *sql.Conn
}

// NewCallBroker opens the broker database and clears inflight calls left by a restart.
func NewCallBroker(path, instanceId string, budget ...int64) *CallBroker {
	limit := int64(20_000_000)
	if len(budget) > 0 {
		limit = budget[0]
	}
	if !jsSafeInteger(limit) || limit < 1 {
		panic(errors.New("Invalid budget"))
	}
	db := MustOpenSQLite(path)
	conn, err := db.Conn(context.Background())
	if err != nil {
		_ = db.Close()
		panic(err)
	}
	broker := &CallBroker{db: db, conn: conn}
	kernelExec(conn, `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS account (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        instance TEXT NOT NULL, budget INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, hold TEXT);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, reserved INTEGER NOT NULL,
        state TEXT NOT NULL, usage TEXT);`)
	kernelExec(conn, "INSERT OR IGNORE INTO account(singleton,instance,budget) VALUES(1,?,?)", instanceId, limit)
	account := broker.account()
	if kernelString(account["instance"]) != instanceId || kernelInt(account["budget"]) != limit {
		broker.Close()
		panic(errors.New("Persisted instance or budget mismatch"))
	}
	broker.transaction(func() {
		if kernelChanges(conn, "UPDATE calls SET state='unknown' WHERE state='inflight'") > 0 {
			kernelExec(conn, "UPDATE account SET hold='unknown usage after restart'")
		}
	})
	return broker
}

func (broker *CallBroker) account() map[string]any {
	return kernelRow(broker.conn, "SELECT * FROM account")
}

func (broker *CallBroker) transaction(action func()) {
	if _, err := broker.conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		panic(err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = broker.conn.ExecContext(context.Background(), "ROLLBACK")
		}
		if rec := recover(); rec != nil {
			panic(rec)
		}
	}()
	action()
	if _, err := broker.conn.ExecContext(context.Background(), "COMMIT"); err != nil {
		panic(err)
	}
	committed = true
}

// Dispatch reserves one call and runs send in the same turn. A send failure settles unknown usage.
func (broker *CallBroker) Dispatch(id string, reservation int64, send func() any) any {
	if id == "" || !jsSafeInteger(reservation) || reservation < 0 {
		panic(errors.New("Invalid call"))
	}
	broker.Check(reservation)
	broker.transaction(func() {
		if kernelRow(broker.conn, "SELECT id FROM calls WHERE id=?", id) != nil {
			panic(errors.New("Invocation already dispatched"))
		}
		kernelExec(broker.conn, "INSERT INTO calls VALUES(?,?,'inflight',NULL)", id, reservation)
	})
	defer func() {
		if rec := recover(); rec != nil {
			broker.Settle(id, nil)
			panic(rec)
		}
	}()
	return send()
}

// Check refuses a paused instance, a hold, or a reservation past the budget.
func (broker *CallBroker) Check(reservation ...int64) {
	extra := int64(0)
	if len(reservation) > 0 {
		extra = reservation[0]
	}
	account := broker.account()
	if kernelInt(account["paused"]) != 0 {
		panic(errors.New("Instance paused"))
	}
	if account["hold"] != nil && kernelString(account["hold"]) != "" {
		panic(errors.New(kernelString(account["hold"])))
	}
	inspected := broker.Inspect()
	if kernelInt(account["used"])+inspected.Reserved+extra > kernelInt(account["budget"]) {
		panic(errors.New("Insufficient token budget"))
	}
}

// Settle records usage or an unknown hold for one invocation.
func (broker *CallBroker) Settle(id string, usage *TokenUsage) {
	var serialized *string
	var total int64
	if usage != nil {
		values := []int64{usage.Input, usage.Output, usage.CacheRead, usage.CacheWrite}
		for _, value := range values {
			if !jsSafeInteger(value) || value < 0 {
				panic(errors.New("Invalid usage"))
			}
		}
		total = values[0] + values[1] + values[2] + values[3]
		if !jsSafeInteger(total) {
			panic(errors.New("Invalid usage total"))
		}
		encoded, err := json.Marshal(values)
		if err != nil {
			panic(err)
		}
		text := string(encoded)
		serialized = &text
	}
	broker.transaction(func() {
		row := kernelRow(broker.conn, "SELECT * FROM calls WHERE id=?", id)
		if row == nil {
			panic(errors.New("Unknown invocation"))
		}
		if kernelString(row["state"]) == "complete" {
			current := kernelString(row["usage"])
			wanted := ""
			if serialized != nil {
				wanted = *serialized
			}
			if (row["usage"] == nil && serialized != nil) || (row["usage"] != nil && serialized == nil) || (row["usage"] != nil && current != wanted) {
				panic(errors.New("Conflicting usage evidence"))
			}
			return
		}
		if usage == nil {
			kernelExec(broker.conn, "UPDATE calls SET state='unknown' WHERE id=?", id)
			kernelExec(broker.conn, "UPDATE account SET hold='unknown usage'")
			return
		}
		kernelExec(broker.conn, "UPDATE calls SET state='complete', usage=?, reserved=0 WHERE id=?", *serialized, id)
		kernelExec(broker.conn, "UPDATE account SET used=used+?", total)
		if total > kernelInt(row["reserved"]) {
			kernelExec(broker.conn, "UPDATE account SET hold='usage exceeded reservation'")
		}
	})
}

// Pause stops new dispatch.
func (broker *CallBroker) Pause() {
	kernelExec(broker.conn, "UPDATE account SET paused=1")
}

// Resume clears the pause flag.
func (broker *CallBroker) Resume() {
	kernelExec(broker.conn, "UPDATE account SET paused=0")
}

// Inspect returns the account, reserved total, and every call in rowid order.
func (broker *CallBroker) Inspect() CallBrokerInspect {
	account := broker.account()
	rows := kernelRows(broker.conn, "SELECT * FROM calls ORDER BY rowid")
	calls := make([]CallBrokerCall, 0, len(rows))
	reserved := int64(0)
	inflight := 0
	for _, row := range rows {
		call := CallBrokerCall{Id: kernelString(row["id"]), Reserved: kernelInt(row["reserved"]), State: kernelString(row["state"])}
		if row["usage"] != nil {
			usage := kernelString(row["usage"])
			call.Usage = &usage
		}
		calls = append(calls, call)
		reserved += call.Reserved
		if call.State == "inflight" {
			inflight++
		}
	}
	status := "ready"
	if kernelInt(account["paused"]) != 0 {
		if inflight > 0 {
			status = "pausing"
		} else {
			status = "paused"
		}
	} else if account["hold"] != nil && kernelString(account["hold"]) != "" {
		status = "blocked"
	}
	inspected := CallBrokerInspect{
		InstanceId: kernelString(account["instance"]),
		Budget:     kernelInt(account["budget"]),
		Used:       kernelInt(account["used"]),
		Reserved:   reserved,
		Status:     status,
		Calls:      calls,
	}
	if account["hold"] != nil {
		hold := kernelString(account["hold"])
		inspected.Hold = &hold
	}
	return inspected
}

// Close releases the broker connection.
func (broker *CallBroker) Close() {
	if broker.conn != nil {
		_ = broker.conn.Close()
		broker.conn = nil
	}
	if broker.db != nil {
		_ = broker.db.Close()
		broker.db = nil
	}
}
