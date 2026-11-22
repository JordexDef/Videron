package main

import (
	"fmt"
	"os"
	"videron/internal/syncserver"
)

func main() {
	if err := syncserver.Run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
