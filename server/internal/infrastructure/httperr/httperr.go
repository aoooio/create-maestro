// Package httperr maps domain errors onto HTTP. Both the REST handlers and
// the WebSocket upgrade path answer with the same body, so a client parses
// one error shape everywhere.
package httperr

import (
	"encoding/json"
	"net/http"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
)

// Body is the JSON error payload of the REST API and of a refused upgrade.
type Body struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Status maps a protocol error code onto an HTTP status.
func Status(code session.Code) int {
	switch code {
	case session.CodeUnauthorized:
		return http.StatusUnauthorized
	case session.CodeForbiddenRole:
		return http.StatusForbidden
	case session.CodeSessionNotFound:
		return http.StatusNotFound
	case session.CodeSessionFull:
		return http.StatusConflict
	case session.CodeInvalidPayload, session.CodeProtocolVersion:
		return http.StatusBadRequest
	case session.CodeRateLimited:
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}

// Write answers a request with the error, using the status its code implies.
func Write(w http.ResponseWriter, err error) {
	code := session.CodeOf(err)
	WriteStatus(w, Status(code), code, session.MessageOf(err), session.IsRetryable(err))
}

// WriteStatus answers with an explicit status, for the few cases HTTP knows
// better than the domain does — a server that is shutting down, for one.
func WriteStatus(w http.ResponseWriter, status int, code session.Code, message string, retryable bool) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Body{
		Code:      string(code),
		Message:   message,
		Retryable: retryable,
	})
}
