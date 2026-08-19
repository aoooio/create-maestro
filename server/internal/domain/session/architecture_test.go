package session_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The dependency rule is the one thing a reviewer cannot check by reading a
// single file, so it is checked here: the domain knows nothing about
// transport, serialisation or frameworks. If this test fails, the fix is to
// move the offending code out of the domain, never to relax the list.
func TestDomainImportsNothingFromTheOutsideWorld(t *testing.T) {
	forbidden := []string{
		"net/http",
		"encoding/json",
		"log/slog",
		"github.com/gorilla",
		"golang.org/x",
		"/internal/application",
		"/internal/infrastructure",
	}

	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("cannot resolve the package directory: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("cannot read %s: %v", root, err)
	}

	fset := token.NewFileSet()
	checked := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(root, name), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("cannot parse %s: %v", name, err)
		}
		checked++
		for _, imported := range file.Imports {
			path := strings.Trim(imported.Path.Value, `"`)
			for _, banned := range forbidden {
				if strings.Contains(path, banned) {
					t.Errorf("%s imports %q: the domain must stay free of it", name, path)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no domain file was checked, the test is not doing its job")
	}
}
