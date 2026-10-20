package main

import (
	"os"

	"github.com/chenx0414/graph/backend/internal/graph"
)

func main() {
	graph.RunCLI(os.Args[1:])
}
