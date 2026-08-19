package http

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/aoooio/create-maestro/server/internal/domain/session"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/config"
	"github.com/aoooio/create-maestro/server/internal/infrastructure/httperr"
)

// Middleware is the usual decorator shape.
type Middleware func(http.Handler) http.Handler

// Chain applies middlewares so that the first one listed is the outermost.
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}

// Recover turns a panic in a handler into a 500 instead of taking the whole
// server down mid-performance.
func Recover(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("handler panicked",
						slog.Any("panic", rec),
						slog.String("path", r.URL.Path))
					httperr.Write(w, session.Internalf("handler panicked"))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// statusRecorder remembers the status code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap lets http.ResponseController reach the real writer underneath.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// Hijack hands the raw connection over. Without it every WebSocket upgrade
// behind this middleware fails: the library type-asserts on http.Hijacker and
// never looks at Unwrap.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("the underlying writer does not support hijacking")
	}
	r.status = http.StatusSwitchingProtocols
	return hijacker.Hijack()
}

// Flush keeps streaming responses working through the wrapper.
func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// RequestLog writes one structured line per request.
func RequestLog(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			log.Info("http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Duration("duration", time.Since(start)))
		})
	}
}

// CORS answers preflights and tags responses. An empty allow-list echoes the
// caller's origin, which is the development default.
func CORS(cfg config.Config) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && cfg.OriginAllowed(origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ipLimiter keeps one token bucket per client IP, with a sweep so that a long
// running server does not accumulate a bucket per visitor forever.
type ipLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*ipBucket
	limit    rate.Limit
	burst    int
	lastKeep time.Time
}

type ipBucket struct {
	limiter *rate.Limiter
	seen    time.Time
}

func newIPLimiter(perMinute int) *ipLimiter {
	return &ipLimiter{
		buckets:  make(map[string]*ipBucket),
		limit:    rate.Limit(float64(perMinute) / 60.0),
		burst:    perMinute,
		lastKeep: time.Now(),
	}
}

func (l *ipLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastKeep) > 10*time.Minute {
		for key, b := range l.buckets {
			if now.Sub(b.seen) > 10*time.Minute {
				delete(l.buckets, key)
			}
		}
		l.lastKeep = now
	}
	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.buckets[ip] = b
	}
	b.seen = now
	return b.limiter.Allow()
}

// RateLimitByIP protects session creation from a script hammering the API.
func RateLimitByIP(perMinute int) Middleware {
	limiter := newIPLimiter(perMinute)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !limiter.allow(clientIP(r), time.Now()) {
				httperr.Write(w, session.ErrRateLimited)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientIP prefers the first hop of X-Forwarded-For, which is what a reverse
// proxy in front of the server will set.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if first, _, ok := strings.Cut(forwarded, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(forwarded)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
