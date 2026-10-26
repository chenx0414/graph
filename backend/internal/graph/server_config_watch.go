package graph

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"crypto/sha256"
)

// ConfigWatchReport is the watcher's last outcome.
type ConfigWatchReport struct {
	Watching     bool
	Events       int
	Applied      int
	Ignored      int
	LastEventAt  *int64
	LastReason   *string
	FileRevision *int64
}

// ConfigWatch reads the configuration file when it changes.
type ConfigWatch struct {
	mu         sync.Mutex
	path       string
	log        func(string)
	parse      func(string) ConfigWatchParsed
	apply      func(GraphConfig, int) ApplyResult
	readFile   func(string) (string, error)
	now        func() int64
	debounce   time.Duration
	lastDigest *string
	timer      *time.Timer
	stopPoll   chan struct{}
	report     ConfigWatchReport
}

type ConfigWatchParsed struct {
	Config   GraphConfig
	Revision *int64
}

// ConfigDigest is a stable digest of the document, so key order and whitespace never count as a change.
func ConfigDigest(config any) string {
	sum := sha256.Sum256([]byte(CanonicalJSON(config)))
	return hex.EncodeToString(sum[:])
}

type ConfigWatchOptions struct {
	Path       string
	Log        func(string)
	Parse      func(string) ConfigWatchParsed
	Apply      func(GraphConfig, int) ApplyResult
	Watch      *bool
	DebounceMs *int
	ReadFile   func(string) (string, error)
	Now        func() int64
}

func CreateConfigWatch(options ConfigWatchOptions) *ConfigWatch {
	read := options.ReadFile
	if read == nil {
		read = func(path string) (string, error) {
			raw, err := os.ReadFile(path)
			if err != nil {
				return "", err
			}
			return string(raw), nil
		}
	}
	now := options.Now
	if now == nil {
		now = NowMillis
	}
	debounce := 300
	if options.DebounceMs != nil {
		debounce = *options.DebounceMs
	}
	watch := &ConfigWatch{
		path:     options.Path,
		log:      options.Log,
		parse:    options.Parse,
		apply:    options.Apply,
		readFile: read,
		now:      now,
		debounce: time.Duration(debounce) * time.Millisecond,
		report:   ConfigWatchReport{},
	}
	enabled := true
	if options.Watch != nil {
		enabled = *options.Watch
	}
	if enabled {
		// PERF(port): poll the directory's file identity. fsnotify is not an allowed dependency,
		// and a watch on the file itself would miss an atomic rename the way Node's file watch did.
		watch.stopPoll = make(chan struct{})
		watch.report.Watching = true
		go watch.poll()
	}
	return watch
}

func (watch *ConfigWatch) poll() {
	var lastStamp string
	ticker := time.NewTicker(watch.debounce)
	defer ticker.Stop()
	for {
		select {
		case <-watch.stopPoll:
			return
		case <-ticker.C:
			stamp := watch.fileStamp()
			if stamp == lastStamp {
				continue
			}
			lastStamp = stamp
			watch.schedule()
		}
	}
}

func (watch *ConfigWatch) fileStamp() string {
	info, err := os.Stat(watch.path)
	if err != nil {
		return "missing"
	}
	return info.ModTime().UTC().Format(time.RFC3339Nano) + ":" + filepath.Base(watch.path) + ":" + strconv.FormatInt(info.Size(), 10)
}

func (watch *ConfigWatch) schedule() {
	watch.mu.Lock()
	defer watch.mu.Unlock()
	if watch.timer != nil {
		watch.timer.Stop()
	}
	watch.timer = time.AfterFunc(watch.debounce, func() {
		watch.mu.Lock()
		watch.timer = nil
		watch.mu.Unlock()
		watch.HandleChange()
	})
}

func (watch *ConfigWatch) HandleChange() {
	watch.mu.Lock()
	watch.report.Events++
	now := watch.now()
	watch.report.LastEventAt = &now
	watch.mu.Unlock()
	text, err := watch.readFile(watch.path)
	if err != nil {
		reason := "config file unreadable: " + err.Error()
		watch.mu.Lock()
		watch.report.LastReason = &reason
		watch.mu.Unlock()
		watch.log("Configuration file unreadable: " + err.Error())
		return
	}
	var parsed ConfigWatchParsed
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				err = watchRecoverError(rec)
			}
		}()
		parsed = watch.parse(text)
	}()
	if err != nil {
		reason := err.Error()
		watch.mu.Lock()
		watch.report.LastReason = &reason
		watch.mu.Unlock()
		watch.log("Configuration file not applied: " + reason)
		return
	}
	watch.mu.Lock()
	watch.report.FileRevision = parsed.Revision
	digest := ConfigDigest(parsed.Config)
	if watch.lastDigest != nil && digest == *watch.lastDigest {
		watch.report.Ignored++
		watch.mu.Unlock()
		return
	}
	revision := 0
	if parsed.Revision != nil {
		revision = int(*parsed.Revision)
	}
	shown := "unset"
	if watch.report.FileRevision != nil {
		shown = strconv.FormatInt(*watch.report.FileRevision, 10)
	}
	watch.mu.Unlock()
	result := watch.apply(parsed.Config, revision)
	if result.Applied {
		watch.mu.Lock()
		watch.lastDigest = &digest
		watch.report.Applied++
		watch.report.LastReason = nil
		watch.mu.Unlock()
		watch.log("Configuration file applied (revision " + shown + ").")
		return
	}
	reason := "rejected"
	if result.Reason != nil {
		reason = *result.Reason
	}
	watch.mu.Lock()
	watch.report.LastReason = &reason
	watch.mu.Unlock()
	watch.log("Configuration file not applied: " + reason)
}

func (watch *ConfigWatch) Report() ConfigWatchReport {
	watch.mu.Lock()
	defer watch.mu.Unlock()
	return watch.report
}

func (watch *ConfigWatch) Stop() {
	watch.mu.Lock()
	defer watch.mu.Unlock()
	if watch.timer != nil {
		watch.timer.Stop()
		watch.timer = nil
	}
	if watch.stopPoll != nil {
		close(watch.stopPoll)
		watch.stopPoll = nil
	}
	watch.report.Watching = false
}

func watchRecoverError(rec any) error {
	switch value := rec.(type) {
	case *RuntimeError:
		return value
	case error:
		return value
	default:
		return &RuntimeError{Code: "internal", Message: "config watch failed"}
	}
}
