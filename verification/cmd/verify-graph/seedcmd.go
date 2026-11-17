package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"graph/verification/internal/seed"
)

const seedRecordName = "seed.json"

type seedRecord struct {
	PID       int    `json:"pid"`
	Start     string `json:"start"`
	BaseURL   string `json:"baseUrl"`
	Model     string `json:"model"`
	StartedAt string `json:"startedAt"`
	Log       string `json:"log"`
}

func seedRecordPath(meta runMeta) string {
	return filepath.Join(filepath.Dir(meta.StateDir), seedRecordName)
}

func readSeedRecord(meta runMeta) (seedRecord, bool) {
	var record seedRecord
	payload, err := os.ReadFile(seedRecordPath(meta))
	if err != nil {
		return record, false
	}
	if json.Unmarshal(payload, &record) != nil || record.BaseURL == "" {
		return seedRecord{}, false
	}
	return record, true
}

func seedCommand(p paths, args []string) int {
	flags := parseFlags(args)
	if len(flags.rest) == 0 || flags.rest[0] != "serve" {
		return failEnvelope("seed", "seed", codeUsage, "unknown seed verb",
			"use: verify-graph seed serve --record <path> (launch --seed does this for you)").print()
	}
	recordPath := flags.value("record", "")
	if recordPath == "" {
		return failEnvelope("seed", "seed", codeUsage, "seed serve needs --record <path>",
			"run: verify-graph launch --mode execute --seed (it starts this for you)").print()
	}
	final := flags.value("final", "")
	if final == "" {
		final = "已就绪。这条回答来自验证用的替身模型，不消耗真实额度。"
	}
	provider, err := seed.StartProvider(seed.Script{Final: final})
	if err != nil {
		return failEnvelope("seed", "seed", codeDaemonDown, "cannot start the stub model: "+err.Error(),
			"check that loopback ports are available on this machine").print()
	}
	defer provider.Close()

	logPath := flags.value("log", recordPath+".log")
	record := seedRecord{
		PID:       os.Getpid(),
		Start:     lstart(os.Getpid()),
		BaseURL:   provider.BaseURL,
		Model:     "seed",
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		Log:       logPath,
	}
	payload, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return failEnvelope("seed", "seed", codeUsage, err.Error(), "report this as a bug").print()
	}
	if err := os.WriteFile(recordPath, append(payload, '\n'), 0o644); err != nil {
		return failEnvelope("seed", "seed", codeUsage, err.Error(), "check permissions on verification/.run").print()
	}
	result := okEnvelope("seed", "seed", map[string]any{
		"baseUrl": provider.BaseURL, "model": record.Model,
		"pid": record.PID, "note": "serving until SIGTERM; launch --seed starts it and cleanup stops it",
	})
	code := result.print()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	<-stop
	return code
}

func startSeed(p paths, meta runMeta) (seedRecord, error) {
	if record, ok := readSeedRecord(meta); ok && alive(record.PID) && (record.Start == "" || lstart(record.PID) == record.Start) {
		return record, nil
	}
	binary, err := os.Executable()
	if err != nil {
		return seedRecord{}, err
	}
	logPath := filepath.Join(meta.Logs, "seed.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return seedRecord{}, err
	}
	defer logFile.Close()
	_ = os.Remove(seedRecordPath(meta))
	command := exec.Command(binary, "seed", "serve",
		"--record", seedRecordPath(meta), "--log", logPath)
	command.Dir = p.Verification
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return seedRecord{}, fmt.Errorf("cannot start the stub model: %w", err)
	}
	pid := command.Process.Pid
	_ = command.Process.Release()

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if record, ok := readSeedRecord(meta); ok {
			return record, nil
		}
		if !alive(pid) {
			return seedRecord{}, fmt.Errorf("the stub model exited before it published an address; read %s", logPath)
		}
		time.Sleep(50 * time.Millisecond)
	}
	return seedRecord{}, fmt.Errorf("the stub model published no address within 15s; read %s", logPath)
}

func writeSeedConfig(meta runMeta, record seedRecord) error {
	config := seed.DefaultConfig("verify", filepath.Join(filepath.Dir(meta.StateDir), "project"), record.BaseURL)
	config.ModelID = record.Model
	if config.ModelID == "" {
		config.ModelID = "seed"
	}
	return seed.WriteConfig(meta.Config, config)
}

func seedEnv(record seedRecord) []string {
	credential := os.Getenv(seed.DefaultCredentialRef)
	if credential == "" {
		credential = "seed-key"
	}
	return []string{seed.DefaultCredentialRef + "=" + credential}
}

func stopSeed(meta runMeta) string {
	record, ok := readSeedRecord(meta)
	if !ok || record.PID <= 0 || !alive(record.PID) {
		return ""
	}
	if record.Start != "" && lstart(record.PID) != record.Start {
		return fmt.Sprintf("refusing to stop pid %d: it is not the stub model this run started", record.PID)
	}
	_ = syscall.Kill(record.PID, syscall.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(record.PID) {
			return ""
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = syscall.Kill(record.PID, syscall.SIGKILL)
	return ""
}
