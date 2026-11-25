package syncclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"videron/internal/syncclient/synctest"
)

func TestLegacyCatalogAndNamedScopeDowngrade(t *testing.T) {
	p := Profile{Address: "https://test.invalid"}
	var requests []string
	client := &http.Client{Transport: uploadRecorder(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	list, err := p.ListProjects(context.Background(), client)
	if err != nil || list.Supported || !slices.Equal(list.Projects, []Project{{}}) {
		t.Fatal(list, err)
	}
	p.ProjectID = strings.Repeat("e", 64)
	if err = p.UploadMain(client, []byte("test")); !errors.Is(err, ErrSpaceMissing) {
		t.Fatal(err)
	}
	want := []string{"GET /v1/projects", "PUT /v1/projects/" + p.ProjectID + "/main"}
	if !slices.Equal(requests, want) {
		t.Fatal("legacy fallback sent an unscoped write", requests)
	}
	client.Transport = uploadRecorder(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("X-Videron-Project") != p.ProjectID {
			t.Fatal("missing scope on scoped request")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	if _, err := p.Manifest(client); !errors.Is(err, ErrProtocol) {
		t.Fatal("accepted response without scope echo", err)
	}
}

func TestTombstoneRecognizedOnlyForTheRequestedProject(t *testing.T) {
	original := Profile{Address: "https://test.invalid:443", ProjectID: strings.Repeat("a", 64), Pin: strings.Repeat("b", 64), Lineage: strings.Repeat("c", 64), Token: strings.Repeat("d", 64)}
	for _, response := range []struct {
		status      int
		scope, flag string
		expected    error
	}{
		{404, "", "", ErrSpaceMissing}, {410, "", "", ErrProtocol}, {410, strings.Repeat("e", 64), "1", ErrProtocol}, {410, original.ProjectID, "1", ErrProjectDeleted},
	} {
		client := &http.Client{Transport: uploadRecorder(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: response.status, Header: http.Header{"X-Videron-Project": []string{response.scope}, "X-Videron-Project-Deleted": []string{response.flag}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}
		if _, err := original.Manifest(client); !errors.Is(err, response.expected) {
			t.Fatal(response, err)
		}
	}
}

func TestClientReusesFreedProjectNamesInSameSession(t *testing.T) {
	const password = "Project name reuse service password"
	const nonce = "synthetic enrollment nonce"
	server := synctest.NewServer(t, password)
	ctx := t.Context()
	p, err := VerifyCredentials(ctx, server.Addr, password)
	if err != nil {
		t.Fatal(err)
	}
	c := p.Client()
	defer c.CloseIdleConnections()
	create := func() string {
		t.Helper()
		p, err = p.CreateProject(ctx, c, nonce, "Design")
		if err != nil || p.ProjectDeleted {
			t.Fatal("create", err)
		}
		return p.ProjectID
	}
	first := create()
	if p, err = p.RenameProject(ctx, c, first, "Research", "Design"); err != nil {
		t.Fatal(err)
	}
	second := create()
	if second == first || create() != second {
		t.Fatal("reusing a renamed project or failing to retry")
	}
	if p, err = p.DeleteProject(ctx, c, second, "Design"); err != nil {
		t.Fatal(err)
	}
	third := create()
	if third == first || third == second || create() != third {
		t.Fatal("reusing a deleted project or failing to retry")
	}
}
