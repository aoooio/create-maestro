// Package config reads the server configuration from the environment. A
// single binary, a single port, everything else through env vars (§7).
package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Config is the whole runtime configuration.
type Config struct {
	Addr          string
	PublicBaseURL string
	// AllowedOrigins is the WebSocket origin allow-list. Empty means "accept
	// any origin", which is convenient in development and reported as a
	// warning at startup.
	AllowedOrigins []string

	DefaultMaxUsers int
	DefaultBPM      float64
	GroupLabels     []string
	TriggerEcho     bool

	// MaxMessageBytes is the hard cap on an inbound frame (§3.5).
	MaxMessageBytes int64
	// RateBurst / RateSustained are the token bucket of one connection.
	RateBurst     int
	RateSustained float64
	// CreateSessionPerMinute rate-limits session creation per client IP.
	CreateSessionPerMinute int

	SessionTTL      time.Duration
	ShutdownTimeout time.Duration
	LogLevel        slog.Level
	LogFormat       string
}

// Defaults, all taken from the spec.
const (
	DefaultAddr                  = ":8080"
	DefaultMaxMessageBytes int64 = 8 << 10 // 8 KiB
	DefaultRateBurst             = 30      // messages/s, peak
	DefaultRateSustained         = 10      // messages/s, sustained
	DefaultCreatePerMinute       = 30
	DefaultSessionTTL            = 6 * time.Hour
	DefaultShutdownTimeout       = 15 * time.Second
)

// Load reads the configuration, returning an error rather than starting with
// a value nobody meant.
func Load() (Config, error) {
	cfg := Config{
		Addr:                   env("ADDR", DefaultAddr),
		PublicBaseURL:          strings.TrimRight(env("PUBLIC_BASE_URL", ""), "/"),
		AllowedOrigins:         list(env("ALLOWED_ORIGINS", "")),
		GroupLabels:            list(env("GROUP_LABELS", strings.Join(session.DefaultGroupLabels, ","))),
		DefaultMaxUsers:        session.DefaultMaxUsers,
		DefaultBPM:             session.DefaultBPM,
		MaxMessageBytes:        DefaultMaxMessageBytes,
		RateBurst:              DefaultRateBurst,
		RateSustained:          DefaultRateSustained,
		CreateSessionPerMinute: DefaultCreatePerMinute,
		SessionTTL:             DefaultSessionTTL,
		ShutdownTimeout:        DefaultShutdownTimeout,
		LogFormat:              env("LOG_FORMAT", "json"),
	}

	var err error
	if cfg.DefaultMaxUsers, err = intEnv("DEFAULT_MAX_USERS", cfg.DefaultMaxUsers); err != nil {
		return Config{}, err
	}
	if cfg.DefaultBPM, err = floatEnv("DEFAULT_BPM", cfg.DefaultBPM); err != nil {
		return Config{}, err
	}
	if cfg.TriggerEcho, err = boolEnv("TRIGGER_ECHO", false); err != nil {
		return Config{}, err
	}
	if cfg.MaxMessageBytes, err = int64Env("MAX_MESSAGE_BYTES", cfg.MaxMessageBytes); err != nil {
		return Config{}, err
	}
	if cfg.RateBurst, err = intEnv("RATE_BURST", cfg.RateBurst); err != nil {
		return Config{}, err
	}
	if cfg.RateSustained, err = floatEnv("RATE_SUSTAINED", cfg.RateSustained); err != nil {
		return Config{}, err
	}
	if cfg.CreateSessionPerMinute, err = intEnv("CREATE_SESSION_PER_MINUTE", cfg.CreateSessionPerMinute); err != nil {
		return Config{}, err
	}
	if cfg.SessionTTL, err = durationEnv("SESSION_TTL", cfg.SessionTTL); err != nil {
		return Config{}, err
	}
	if cfg.ShutdownTimeout, err = durationEnv("SHUTDOWN_TIMEOUT", cfg.ShutdownTimeout); err != nil {
		return Config{}, err
	}
	if cfg.LogLevel, err = levelEnv("LOG_LEVEL", slog.LevelInfo); err != nil {
		return Config{}, err
	}

	return cfg, cfg.validate()
}

func (c Config) validate() error {
	switch {
	case c.DefaultMaxUsers <= 0:
		return fmt.Errorf("DEFAULT_MAX_USERS must be positive, got %d", c.DefaultMaxUsers)
	case c.DefaultBPM < session.MinBPM || c.DefaultBPM > session.MaxBPM:
		return fmt.Errorf("DEFAULT_BPM must be within [%g, %g], got %g", session.MinBPM, session.MaxBPM, c.DefaultBPM)
	case len(c.GroupLabels) == 0:
		return fmt.Errorf("GROUP_LABELS must name at least one group")
	case c.MaxMessageBytes <= 0:
		return fmt.Errorf("MAX_MESSAGE_BYTES must be positive, got %d", c.MaxMessageBytes)
	case c.RateBurst <= 0 || c.RateSustained <= 0:
		return fmt.Errorf("RATE_BURST and RATE_SUSTAINED must be positive")
	case float64(c.RateBurst) < c.RateSustained:
		return fmt.Errorf("RATE_BURST (%d) cannot be below RATE_SUSTAINED (%g)", c.RateBurst, c.RateSustained)
	}
	return nil
}

// OriginAllowed reports whether a browser origin may open a WebSocket. An
// empty allow-list accepts everything, including requests without an Origin
// header (native clients, load tests).
func (c Config) OriginAllowed(origin string) bool {
	if len(c.AllowedOrigins) == 0 {
		return true
	}
	if origin == "" {
		return false
	}
	for _, allowed := range c.AllowedOrigins {
		if strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

// --- env helpers ---

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func list(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func intEnv(key string, fallback int) (int, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func int64Env(key string, fallback int64) (int64, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func floatEnv(key string, fallback float64) (float64, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func boolEnv(key string, fallback bool) (bool, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func durationEnv(key string, fallback time.Duration) (time.Duration, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func levelEnv(key string, fallback slog.Level) (slog.Level, error) {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback, nil
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return level, nil
}
