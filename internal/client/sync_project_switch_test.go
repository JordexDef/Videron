package client

import (
	"errors"
	"testing"
)

func TestServerDraftDuringProjectSwitch(t *testing.T) {
	for _, variant := range []string{"independent", "keep-local", "keep-remote", "undo-to-base"} {
		t.Run(variant, func(t *testing.T) {
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			local, _ := testStore(t)
			peer := new(App)
			_, err := peer.Load()
			must(err)
			const pass = "Project switch test service password"
			server := startPasswordTestService(t, pass)
			first, second, other := t.TempDir(), t.TempDir(), t.TempDir()

			note := func(id, text string) mergeObject {
				n := mergeTestNote(id, id)
				n["body"] = []any{mergeObject{"type": "paragraph", "runs": []any{mergeObject{"text": text}}}}
				n["plain"] = text
				return n
			}
			document := func(draft, neighbor string) string {
				return mergeTestJSON(t, mergeTestSpace(note("draft", draft), note("neighbor", neighbor)))
			}
			save := func(a *App, folder, id, text string) {
				t.Helper()
				head, err := a.FolderPatchRevision(folder)
				must(err)
				patch := mergeObject{"notes": mergeObject{"put": []any{note(id, text)}}}
				_, err = a.SaveFolderPatch(folder, head, mergeTestJSON(t, patch))
				must(err)
			}
			syncCopy := func(a *App, folder string) {
				t.Helper()
				_, err := a.SyncSpaceServer(folder)
				must(err)
			}
			proposal := func(a *App, folder string) FolderMergeProposal {
				t.Helper()
				p, err := a.PrepareFolderMerge(folder, true, "")
				must(err)
				return p
			}
			reopen := func(a *App, folder, password, want string) {
				t.Helper()
				a.CloseFolderSpace(folder)
				got, err := a.OpenFolderSpace(folder, password)
				must(err)
				sameTestJSON(t, []byte(got), []byte(want))
			}

			must(local.CreateFolderSpace(first, document("original", "neighbor"), testPass))
			must(local.ConnectSpaceServer(first, server.Code))
			must(peer.JoinSpaceServer(server.Code, second))
			reopen(peer, second, testPass, document("original", "neighbor"))
			// Use the same note IDs in another project on this server. A stale
			// selection or patch directed to the current project would change it.
			login, err := local.VerifySyncServer(server.Addr, pass)
			must(err)
			otherProject, err := local.CreateServerProject(login.Ticket, "Other")
			must(err)
			must(local.CreateFolderSpace(other, document("other original", "other neighbor"), ""))
			must(local.ConnectSpaceServer(other, otherProject.Ticket))
			local.CloseFolderSpace(other)

			remoteID := "draft"
			if variant == "independent" {
				remoteID = "neighbor"
			}
			save(local, first, "draft", "local draft")
			save(peer, second, remoteID, "remote first edit")
			syncCopy(peer, second)
			syncCopy(local, first)
			before := proposal(local, first)
			if !before.Prepared {
				t.Fatal("peer's first edit was not offered")
			}
			localText := "local final edit"
			if variant == "undo-to-base" {
				// The editor has undone its own edit and autosaves the old text as
				// a new local revision while the first peer revision awaits review.
				localText = "original"
			}
			save(local, first, "draft", localText)
			if _, err = local.CommitFolderMergeChoices(first, before.Token, nil); !errors.Is(err, errChanged) {
				t.Fatalf("stale review survived a new local edit: %v", err)
			}
			if !local.SuspendFolderSpace(first) {
				t.Fatal("encrypted project did not suspend")
			}
			reopen(local, other, "", document("other original", "other neighbor"))
			save(local, other, "draft", "other project edit")
			syncCopy(local, other)
			if _, err = local.CommitFolderMergeChoices(first, before.Token, nil); !errors.Is(err, errLocked) {
				t.Fatalf("accepted a decision for a suspended project: %v", err)
			}
			save(peer, second, remoteID, "remote final edit")
			syncCopy(peer, second)

			local.CloseFolderSpace(other)
			got, err := local.ResumeFolderSpace(first)
			must(err)
			sameTestJSON(t, []byte(got), []byte(document(localText, "neighbor")))
			syncCopy(local, first)
			latest := proposal(local, first)
			if !latest.Prepared || latest.Token == before.Token {
				t.Fatal("returning to the project did not refresh the proposal")
			}
			want := document(localText, "remote final edit")
			var choices map[string]string
			switch variant {
			case "independent", "undo-to-base":
				if len(latest.Conflicts) != 0 {
					t.Fatal("unnecessary conflict", latest.Conflicts)
				}
				if variant == "undo-to-base" {
					want = document("remote final edit", "neighbor")
				}
			default:
				if len(latest.Conflicts) != 1 || latest.Conflicts[0].Key != "note:draft" {
					t.Fatal("missing same-note conflict", latest.Conflicts)
				}
				c := latest.Conflicts[0]
				sameTestJSON(t, []byte(mergeTestJSON(t, c.Local)), []byte(mergeTestJSON(t, note("draft", "local final edit"))))
				sameTestJSON(t, []byte(mergeTestJSON(t, c.Remote)), []byte(mergeTestJSON(t, note("draft", "remote final edit"))))
				if _, err = local.CommitFolderMergeChoices(first, latest.Token, nil); !errors.Is(err, errInvalid) {
					t.Fatalf("unresolved conflict was accepted: %v", err)
				}
				choices = map[string]string{c.Key: "local"}
				want = document("local final edit", "neighbor")
				if variant == "keep-remote" {
					choices[c.Key] = "remote"
					want = document("remote final edit", "neighbor")
				}
			}
			_, err = local.CommitFolderMergeChoices(first, latest.Token, choices)
			must(err)
			syncCopy(local, first)
			reopen(local, first, testPass, want)

			// Verify both the existing peer and an empty directory populated
			// exclusively from the server. Each must reach a single settled head.
			cold := t.TempDir()
			must(peer.JoinSpaceServer(server.Code, cold))
			_, err = peer.OpenFolderSpace(cold, testPass)
			must(err)
			for _, folder := range []string{second, cold} {
				syncCopy(peer, folder)
				if p := proposal(peer, folder); p.Prepared {
					_, err = peer.CommitFolderMergeChoices(folder, p.Token, nil)
					must(err)
				}
				reopen(peer, folder, testPass, want)
				if p := proposal(peer, folder); p.Token != "" {
					t.Fatal("another branch appeared after reopening", p)
				}
			}
			reopen(local, other, "", document("other project edit", "other neighbor"))
		})
	}
}
