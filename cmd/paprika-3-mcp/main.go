package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/soggycactus/paprika-3-mcp/internal/mcpserver"
)

var version = "dev" // set during build with -ldflags

func main() {
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("paprika-3-mcp version %s\n", version)
		os.Exit(0)
	}

	// Credentials come from the environment only. Passing a password as a
	// command-line flag exposes it to every process that can list processes.
	username := os.Getenv("PAPRIKA_USERNAME")
	password := os.Getenv("PAPRIKA_PASSWORD")
	if username == "" || password == "" {
		fmt.Fprintln(os.Stderr, "PAPRIKA_USERNAME and PAPRIKA_PASSWORD environment variables are required")
		os.Exit(1)
	}

	// MCP uses stdout for the protocol, so logs go to stderr. Claude Desktop
	// saves each server's stderr to its own log file.
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	s, err := mcpserver.NewServer(mcpserver.NewServerOptions{
		Version:  version,
		Username: username,
		Password: password,
		Logger:   logger,
	})
	if err != nil {
		logger.Error("failed to start paprika-3-mcp server", "err", err)
		os.Exit(1)
	}

	logger.Info("starting mcp server", "version", version)
	s.Start()
}
