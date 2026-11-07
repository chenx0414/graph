package graph

import (
	"sync"

	"context"
)

type ChangeWait struct {
	Promise <-chan struct{}
	Cancel  func()
}

func (s *TaskStore) WaitForChange(signal context.Context) ChangeWait {
	ch := make(chan struct{}, 1)
	var once sync.Once
	finish := func() {
		once.Do(func() {
			s.mu.Lock()
			next := s.waiters[:0]
			for _, waiter := range s.waiters {
				if waiter != ch {
					next = append(next, waiter)
				}
			}
			s.waiters = next
			s.mu.Unlock()
			select {
			case ch <- struct{}{}:
			default:
			}
		})
	}
	if signal != nil && signal.Err() != nil {
		finish()
		return ChangeWait{Promise: ch, Cancel: finish}
	}
	s.mu.Lock()
	s.waiters = append(s.waiters, ch)
	s.mu.Unlock()
	if signal != nil {
		done := signal.Done()
		if done != nil {
			go func() {
				<-done
				finish()
			}()
		}
	}
	return ChangeWait{Promise: ch, Cancel: finish}
}
