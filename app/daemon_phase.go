package main

type daemonPhase string

const (
	daemonStopped    daemonPhase = "stopped"
	daemonStarting   daemonPhase = "starting"
	daemonLaunchd daemonPhase = "supervised"
	daemonOwned      daemonPhase = "owned"
	daemonAdopted    daemonPhase = "adopted"
	daemonStopping   daemonPhase = "stopping"
)

type daemonEvent string

const (
	daemonEventStart             daemonEvent = "start"
	daemonEventStartedSupervised daemonEvent = "started-supervised"
	daemonEventStartedOwned      daemonEvent = "started-owned"
	daemonEventStartFailed       daemonEvent = "start-failed"
	daemonEventExited            daemonEvent = "exited"
	daemonEventAdopt             daemonEvent = "adopt"
	daemonEventStop              daemonEvent = "stop"
	daemonEventStopped           daemonEvent = "stopped"
)

type daemonTransitionRule struct {
	from  daemonPhase
	event daemonEvent
	to    daemonPhase
}

var daemonTransitions = []daemonTransitionRule{
	{daemonStopped, daemonEventStart, daemonStarting},
	{daemonStarting, daemonEventStartedSupervised, daemonLaunchd},
	{daemonStarting, daemonEventStartedOwned, daemonOwned},
	{daemonStarting, daemonEventStartFailed, daemonStopped},
	{daemonOwned, daemonEventExited, daemonStopped},
	{daemonOwned, daemonEventStop, daemonStopping},
	{daemonAdopted, daemonEventStop, daemonStopping},
	{daemonStopping, daemonEventStopped, daemonStopped},
	{daemonLaunchd, daemonEventStop, daemonStopped},
	{daemonStopped, daemonEventAdopt, daemonAdopted},
	{daemonLaunchd, daemonEventAdopt, daemonLaunchd},
}

func daemonTransition(phase daemonPhase, event daemonEvent) (daemonPhase, bool) {
	for _, rule := range daemonTransitions {
		if rule.from == phase && rule.event == event {
			return rule.to, true
		}
	}
	return phase, false
}

func (phase daemonPhase) Label() string {
	switch phase {
	case daemonStopped:
		return "未启动"
	case daemonStarting:
		return "启动中"
	case daemonLaunchd:
		return "由 launchd 托管"
	case daemonOwned:
		return "本窗口启动"
	case daemonAdopted:
		return "已接管的进程"
	case daemonStopping:
		return "停止中"
	}
	return "未知"
}

func (phase daemonPhase) TracksAProcess() bool {
	return phase == daemonLaunchd || phase == daemonOwned || phase == daemonAdopted
}

type daemonStatus struct {
	Phase      daemonPhase
	Pid        int
	Supervised bool
}
