package graph

import (
	"database/sql"
	"sync"
)

func (s *TaskStore) emitChange() {
	s.mu.Lock()
	waiters := s.waiters
	s.waiters = nil
	listeners := append([]func(string){}, s.listeners...)
	s.mu.Unlock()
	for _, waiter := range waiters {
		select {
		case waiter <- struct{}{}:
		default:
		}
	}
	for _, listener := range listeners {
		_ = listener
	}
}

func (s *TaskStore) OnEvent(listener func(string)) func() {
	s.mu.Lock()
	s.listeners = append(s.listeners, listener)
	index := len(s.listeners) - 1
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if index >= 0 && index < len(s.listeners) && &s.listeners[index] != nil {
				fn := s.listeners[index]
				if &fn == nil {
				}
				next := make([]func(string), 0, len(s.listeners))
				removed := false
				for i, item := range s.listeners {
					if !removed && i == index {
						removed = true
						continue
					}
					next = append(next, item)
				}
				s.listeners = next
				index = -1
			}
			s.mu.Unlock()
		})
	}
}

func (s *TaskStore) IsTransaction() bool {
	return s.InTransaction()
}

// InTransaction is a property of this handle: a goroutine holding the pool store is not inside another's transaction.
func (s *TaskStore) InTransaction() bool {
	return s.inTx
}

// Transaction runs a body on a connection it owns, so no other goroutine's statement can land inside it.
func (s *TaskStore) Transaction(action any) any {
	if s.inTx {
		return storeTransactionAction(s, action)
	}
	s.txMu.Lock()
	defer s.txMu.Unlock()
	handle, end := s.transactionConn()
	ended := false
	defer func() {
		if ended {
			return
		}
		if err := end(false); err != nil {
			panic(err)
		}
	}()
	inTx := s.transactionScoped(handle)
	result := storeTransactionAction(inTx, action)
	ended = true
	if err := end(true); err != nil {
		panic(err)
	}
	s.emitChange()
	return result
}

func (s *TaskStore) runTransactionStatement(statement string) error {
	if s.transactionExec != nil {
		return s.transactionExec(statement)
	}
	_, err := s.DB.Exec(statement)
	return err
}

// storeTransactionAction runs a transaction body, handing it the store the transaction owns. A
// body that asks for that store by parameter gets it; a body that ignores it keeps working while
// the call sites are migrated one batch at a time.
func storeTransactionAction(tx *TaskStore, action any) any {
	switch fn := action.(type) {
	case func():
		fn()
		return nil
	case func() any:
		return fn()
	case func(*TaskStore):
		fn(tx)
		return nil
	case func(*TaskStore) any:
		return fn(tx)
	default:
		Raise("invalid_input", "Unsupported transaction callback")
	}
	return nil
}

func (s *TaskStore) Command(scope, requestID string, payload any, apply any) any {
	if requestID == "" || len(requestID) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	encoded := CanonicalJSON(payload)
	return s.Transaction(func(tx *TaskStore) any {
		var previousPayload, receipt string
		err := tx.DB.QueryRow("SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", scope, requestID).Scan(&previousPayload, &receipt)
		if err == nil {
			if previousPayload != encoded {
				Raise("idempotency_conflict", "requestId was already used with different content")
			}
			return parseJSON(receipt)
		}
		if err != sql.ErrNoRows {
			panic(err)
		}
		result := storeTransactionAction(tx, apply)
		tx.RecordCommand(scope, requestID, encoded, CanonicalJSON(result))
		return result
	})
}

func (s *TaskStore) RecordCommand(scope, requestID, encoded, receipt string) {
	if _, err := s.DB.Exec("INSERT INTO commands VALUES(?,?,?,?)", scope, requestID, encoded, receipt); err != nil {
		panic(err)
	}
}

func eventTaskID(taskID any) any {
	switch v := taskID.(type) {
	case nil:
		return nil
	case *string:
		if v == nil {
			return nil
		}
		return *v
	case string:
		return v
	default:
		return taskID
	}
}

func (s *TaskStore) Event(taskID any, eventType string, data any) int64 {
	res, err := s.DB.Exec("INSERT INTO events(task_id,type,data,timestamp) VALUES(?,?,?,?)", eventTaskID(taskID), eventType, CanonicalJSON(data), NowMillis())
	if err != nil {
		panic(err)
	}
	cursor, err := res.LastInsertId()
	if err != nil {
		panic(err)
	}
	s.emitChange()
	s.mu.Lock()
	listeners := append([]func(string){}, s.listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(eventType)
	}
	return cursor
}
