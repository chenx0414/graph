package appinstance

import "fmt"

// StopAppWindow stops only the window process, leaving the daemon (and any
// seeded model) alive. A surface journey opens a window on an existing run; it
// must not tear that run down for the journeys that follow it.
func (i *Instance) StopAppWindow() []string {
	stopped := []string{}
	if i.AppPID > 0 {
		if result, err := stopProcess(i.AppPID, i.Options.Root); err == nil {
			stopped = append(stopped, fmt.Sprintf("app pid %d: %s", i.AppPID, result))
			i.AppPID = 0
		} else {
			stopped = append(stopped, fmt.Sprintf("app pid %d: %v", i.AppPID, err))
		}
	}
	_ = i.Save()
	return stopped
}
