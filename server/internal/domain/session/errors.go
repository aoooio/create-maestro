package session

import (
	"errors"
	"fmt"
)

// Code is a protocol-level error code (§4.3). The domain speaks these codes
// directly so that no translation table is needed at the wire boundary.
type Code string

const (
	CodeUnauthorized    Code = "unauthorized"
	CodeForbiddenRole   Code = "forbidden_role"
	CodeSessionNotFound Code = "session_not_found"
	CodeSessionFull     Code = "session_full"
	CodeInvalidPayload  Code = "invalid_payload"
	CodeRateLimited     Code = "rate_limited"
	CodeProtocolVersion Code = "protocol_version"
	CodeInternal        Code = "internal"
)

// Error is the typed business error carried across every layer.
type Error struct {
	Code      Code
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func newError(code Code, retryable bool, msg string) *Error {
	return &Error{Code: code, Message: msg, Retryable: retryable}
}

// Sentinels for the cases that carry no extra context.
var (
	ErrUnauthorized     = newError(CodeUnauthorized, false, "invalid or missing maestro token")
	ErrForbiddenRole    = newError(CodeForbiddenRole, false, "this action is reserved to the maestro")
	ErrMaestroTaken     = newError(CodeForbiddenRole, true, "a maestro is already connected to this session")
	ErrSessionNotFound  = newError(CodeSessionNotFound, false, "session not found")
	ErrSessionFull      = newError(CodeSessionFull, true, "session is full")
	ErrSessionClosed    = newError(CodeSessionNotFound, false, "session is closed")
	ErrParticipantGone  = newError(CodeInvalidPayload, false, "participant is not part of this session")
	ErrRateLimited      = newError(CodeRateLimited, true, "too many messages, slow down")
	ErrHelloRequired    = newError(CodeUnauthorized, false, "the first message must be hello")
	ErrUnknownGroup     = newError(CodeInvalidPayload, false, "unknown group")
	ErrUnknownParameter = newError(CodeInvalidPayload, false, "unknown parameter key")
)

// Invalidf builds an invalid_payload error with context.
func Invalidf(format string, args ...any) *Error {
	return newError(CodeInvalidPayload, false, fmt.Sprintf(format, args...))
}

// Internalf builds a server-side failure. Its message stays server-side:
// MessageOf only reveals it for domain errors the client can act on.
func Internalf(format string, args ...any) *Error {
	return newError(CodeInternal, true, fmt.Sprintf(format, args...))
}

// CodeOf extracts the protocol code of any error, defaulting to internal.
func CodeOf(err error) Code {
	if err == nil {
		return ""
	}
	var derr *Error
	if errors.As(err, &derr) {
		return derr.Code
	}
	return CodeInternal
}

// IsRetryable reports whether the client may retry the same command later.
func IsRetryable(err error) bool {
	var derr *Error
	if errors.As(err, &derr) {
		return derr.Retryable
	}
	return false
}

// MessageOf returns a client-safe message for err.
func MessageOf(err error) string {
	if err == nil {
		return ""
	}
	var derr *Error
	if errors.As(err, &derr) && derr.Code != CodeInternal {
		return derr.Message
	}
	return "internal error"
}
