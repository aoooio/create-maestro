package httperr

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

func TestStatusMapping(t *testing.T) {
	tests := map[session.Code]int{
		session.CodeUnauthorized:    http.StatusUnauthorized,
		session.CodeForbiddenRole:   http.StatusForbidden,
		session.CodeSessionNotFound: http.StatusNotFound,
		session.CodeSessionFull:     http.StatusConflict,
		session.CodeInvalidPayload:  http.StatusBadRequest,
		session.CodeProtocolVersion: http.StatusBadRequest,
		session.CodeRateLimited:     http.StatusTooManyRequests,
		session.CodeInternal:        http.StatusInternalServerError,
		"something else":            http.StatusInternalServerError,
	}
	for code, want := range tests {
		if got := Status(code); got != want {
			t.Fatalf("Status(%s) = %d, want %d", code, got, want)
		}
	}
}

func TestWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, session.ErrSessionFull)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", ct)
	}
	var body Body
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("cannot decode %s: %v", rec.Body, err)
	}
	if body.Code != string(session.CodeSessionFull) || !body.Retryable {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestWriteHidesInternalDetails(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, errors.New("dial tcp 10.0.0.1:5432: connection refused"))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	var body Body
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("cannot decode %s: %v", rec.Body, err)
	}
	if body.Message != "internal error" {
		t.Fatalf("the internal message leaked: %q", body.Message)
	}
}

func TestWriteStatusOverridesTheMapping(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteStatus(rec, http.StatusServiceUnavailable, session.CodeInternal, "server is shutting down", true)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
	var body Body
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("cannot decode %s: %v", rec.Body, err)
	}
	if body.Message != "server is shutting down" || !body.Retryable {
		t.Fatalf("unexpected body: %+v", body)
	}
}
