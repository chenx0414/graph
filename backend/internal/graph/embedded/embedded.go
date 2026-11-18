package embedded

import (
	"embed"
	"io/fs"
)

//go:embed presets runtime
var assets embed.FS

func Presets() fs.FS {
	return mustSub("presets")
}

func Runtime() fs.FS {
	return mustSub("runtime")
}

func mustSub(name string) fs.FS {
	sub, err := fs.Sub(assets, name)
	if err != nil {
		panic(err)
	}
	return sub
}
