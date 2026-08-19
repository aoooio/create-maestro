package observability

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestNewLoggerFormats(t *testing.T) {
	if NewLogger(slog.LevelInfo, "json") == nil || NewLogger(slog.LevelDebug, "text") == nil {
		t.Fatal("both formats must produce a logger")
	}
}

func TestTaggedLoggersCarryTheOperationalKeys(t *testing.T) {
	var buf bytes.Buffer
	base := slog.New(slog.NewJSONHandler(&buf, nil))

	Participant(Role(Session(base, "sess-1"), session.RoleMaestro), "p-1").Info("joined")

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &line); err != nil {
		t.Fatalf("cannot decode %s: %v", buf.String(), err)
	}
	if line["sessionId"] != "sess-1" || line["participantId"] != "p-1" || line["role"] != "maestro" {
		t.Fatalf("missing operational keys: %+v", line)
	}

	buf.Reset()
	Session(base, "sess-2").Info("created")
	if !strings.Contains(buf.String(), `"sessionId":"sess-2"`) {
		t.Fatalf("the session logger must tag the session: %s", buf.String())
	}
}
