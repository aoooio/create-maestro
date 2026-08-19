package config

import (
	"log/slog"
	"testing"
	"time"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != DefaultAddr || cfg.MaxMessageBytes != DefaultMaxMessageBytes {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.DefaultMaxUsers != session.DefaultMaxUsers || cfg.DefaultBPM != session.DefaultBPM {
		t.Fatalf("the defaults must come from the domain: %+v", cfg)
	}
	if len(cfg.GroupLabels) != 2 || cfg.GroupLabels[0] != "HIGH" {
		t.Fatalf("unexpected groups: %+v", cfg.GroupLabels)
	}
	if cfg.TriggerEcho {
		t.Fatal("trigger echo must be off by default")
	}
}

func TestLoadReadsTheEnvironment(t *testing.T) {
	t.Setenv("ADDR", ":9999")
	t.Setenv("PUBLIC_BASE_URL", "https://maestro.example/")
	t.Setenv("ALLOWED_ORIGINS", "https://a.example, https://b.example")
	t.Setenv("GROUP_LABELS", "LOW,MID,HIGH")
	t.Setenv("DEFAULT_MAX_USERS", "50")
	t.Setenv("DEFAULT_BPM", "128")
	t.Setenv("TRIGGER_ECHO", "true")
	t.Setenv("MAX_MESSAGE_BYTES", "4096")
	t.Setenv("RATE_BURST", "20")
	t.Setenv("RATE_SUSTAINED", "5")
	t.Setenv("SESSION_TTL", "30m")
	t.Setenv("SHUTDOWN_TIMEOUT", "3s")
	t.Setenv("LOG_LEVEL", "debug")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != ":9999" || cfg.PublicBaseURL != "https://maestro.example" {
		t.Fatalf("unexpected addressing: %+v", cfg)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[1] != "https://b.example" {
		t.Fatalf("origins must be split and trimmed: %+v", cfg.AllowedOrigins)
	}
	if len(cfg.GroupLabels) != 3 || !cfg.TriggerEcho || cfg.MaxMessageBytes != 4096 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	if cfg.SessionTTL != 30*time.Minute || cfg.ShutdownTimeout != 3*time.Second {
		t.Fatalf("unexpected durations: %+v", cfg)
	}
	if cfg.LogLevel != slog.LevelDebug {
		t.Fatalf("log level = %v", cfg.LogLevel)
	}
}

func TestLoadRejectsNonsense(t *testing.T) {
	tests := map[string][2]string{
		"unreadable int":      {"DEFAULT_MAX_USERS", "many"},
		"unreadable float":    {"DEFAULT_BPM", "fast"},
		"unreadable bool":     {"TRIGGER_ECHO", "maybe"},
		"unreadable duration": {"SESSION_TTL", "a while"},
		"unreadable level":    {"LOG_LEVEL", "shouty"},
		"unreadable size":     {"MAX_MESSAGE_BYTES", "big"},
		"impossible bpm":      {"DEFAULT_BPM", "5"},
		"empty groups":        {"GROUP_LABELS", " , "},
		"negative users":      {"DEFAULT_MAX_USERS", "-1"},
		"burst below rate":    {"RATE_BURST", "1"},
	}
	for name, kv := range tests {
		t.Run(name, func(t *testing.T) {
			t.Setenv(kv[0], kv[1])
			if _, err := Load(); err == nil {
				t.Fatalf("%s=%q should have been refused", kv[0], kv[1])
			}
		})
	}
}

func TestOriginAllowed(t *testing.T) {
	open := Config{}
	if !open.OriginAllowed("https://anywhere.example") || !open.OriginAllowed("") {
		t.Fatal("an empty allow-list accepts everything, including no origin at all")
	}

	strict := Config{AllowedOrigins: []string{"https://maestro.example"}}
	if !strict.OriginAllowed("https://MAESTRO.example") {
		t.Fatal("the comparison must be case insensitive")
	}
	if strict.OriginAllowed("https://evil.example") || strict.OriginAllowed("") {
		t.Fatal("anything outside the allow-list must be refused, including a missing origin")
	}
}
