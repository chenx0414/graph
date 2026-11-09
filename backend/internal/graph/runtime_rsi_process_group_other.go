//go:build !unix

package graph

import "os/exec"

func rsiPrepareProcessGroup(command *exec.Cmd) {}

func rsiKillProcessGroup(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}

func rsiProcessAlive(pid int) bool {
	return pid > 0
}
