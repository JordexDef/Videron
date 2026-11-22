// Package syncauth binds Videron's first-use TLS certificate to an RFC 9807
// OPAQUE password exchange. The client takes the pin from the TLS connection
// carrying KE2, and only sends KE3 over a connection pinned to that certificate.
package syncauth

import (
	"bytes"
	"crypto"
	"errors"
	"unicode/utf8"

	"github.com/bytemare/ksf"
	"github.com/bytemare/opaque"
)

const (
	MaxPasswordBytes = 1024
	clientIdentity   = "Videron sync client"
)

func configuration() *opaque.Configuration {
	// These choices are part of the persistent v1 credential format.
	return &opaque.Configuration{
		OPRF: opaque.RistrettoSha512, AKE: opaque.RistrettoSha512,
		KSF: ksf.Argon2id, KDF: crypto.SHA512, MAC: crypto.SHA512, Hash: crypto.SHA512,
		Context: []byte("Videron sync enrollment v1"),
	}
}

func passwordOptions() *opaque.ClientOptions {
	// Argon2id time, memory in KiB and parallelism. Retain these values
	// across dependency upgrades so previously registered clients agree.
	return &opaque.ClientOptions{KSFParameters: []uint64{3, 64 * 1024, 4}, KSFLength: 32}
}

func validatePassword(password []byte) error {
	if len(password) > MaxPasswordBytes || len(bytes.TrimSpace(password)) == 0 ||
		!utf8.Valid(password) || bytes.ContainsAny(password, "\r\n\x00") {
		return errors.New("enter a single-line password of up to 1024 UTF-8 bytes")
	}
	return nil
}

type Client struct{ client *opaque.Client }

func Begin(password string) (*Client, []byte, error) {
	pw := []byte(password)
	defer clear(pw)
	if err := validatePassword(pw); err != nil {
		return nil, nil, err
	}
	c, err := configuration().Client()
	if err != nil {
		return nil, nil, err
	}
	ke1, err := c.GenerateKE1(pw)
	if err != nil {
		c.ClearState()
		return nil, nil, err
	}
	return &Client{c}, ke1.Serialize(), nil
}

func (c *Client) Close() { c.client.ClearState() }

func (c *Client) Finish(response []byte, pin string) ([]byte, error) {
	ke2, err := c.client.Deserialize.KE2(response)
	if err != nil {
		return nil, err
	}
	ke3, sessionKey, exportKey, err := c.client.GenerateKE3(ke2, []byte(clientIdentity), []byte(pin), passwordOptions())
	clear(sessionKey)
	clear(exportKey)
	if err != nil {
		return nil, err
	}
	return ke3.Serialize(), nil
}

// Registration is private server state. The only registration interface is
// the local server CLI. Each password rotation creates a fresh record.
type Registration struct {
	KeyMaterial []byte `json:"keyMaterial"`
	ID          []byte `json:"id"`
	Record      []byte `json:"record"`
}

func Register(password []byte, pin string) (*Registration, error) {
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	conf := configuration()
	server, err := conf.Server()
	if err != nil {
		return nil, err
	}
	sk, pk := conf.KeyGen()
	material := &opaque.ServerKeyMaterial{Identity: []byte(pin), OPRFGlobalSeed: conf.GenerateOPRFSeed(),
		PrivateKey: sk, PublicKeyBytes: pk.Encode()}
	defer material.Flush()
	if err = server.SetKeyMaterial(material); err != nil {
		return nil, err
	}
	client, err := conf.Client()
	if err != nil {
		return nil, err
	}
	defer client.ClearState()
	req, err := client.RegistrationInit(password)
	if err != nil {
		return nil, err
	}
	id := opaque.RandomBytes(32)
	resp, err := server.RegistrationResponse(req, id, nil)
	if err != nil {
		return nil, err
	}
	record, exportKey, err := client.RegistrationFinalize(resp, []byte(clientIdentity), material.Identity, passwordOptions())
	clear(exportKey)
	if err != nil {
		return nil, err
	}
	return &Registration{material.Encode(), id, record.Serialize()}, nil
}

type Verifier struct {
	server *opaque.Server
	record *opaque.ClientRecord
}

func (reg *Registration) Open(pin string) (*Verifier, error) {
	conf := configuration()
	material, err := conf.DecodeServerKeyMaterial(reg.KeyMaterial)
	if err != nil {
		return nil, err
	}
	if string(material.Identity) != pin || len(pin) != 64 || len(reg.ID) != 32 {
		return nil, errors.New("invalid registration identity")
	}
	server, err := conf.Server()
	if err != nil {
		return nil, err
	}
	if err = server.SetKeyMaterial(material); err != nil {
		return nil, err
	}
	record, err := server.Deserialize.RegistrationRecord(reg.Record)
	if err != nil {
		return nil, err
	}
	return &Verifier{server, &opaque.ClientRecord{CredentialIdentifier: reg.ID, ClientIdentity: []byte(clientIdentity), RegistrationRecord: record}}, nil
}

func (v *Verifier) Start(message []byte) (response, expectedMAC []byte, err error) {
	ke1, err := v.server.Deserialize.KE1(message)
	if err != nil {
		return nil, nil, err
	}
	ke2, output, err := v.server.GenerateKE2(ke1, v.record)
	if err != nil {
		return nil, nil, err
	}
	clear(output.SessionSecret)
	return ke2.Serialize(), output.ClientMAC, nil
}

func (v *Verifier) Finish(message, expectedMAC []byte) bool {
	ke3, err := v.server.Deserialize.KE3(message)
	return err == nil && v.server.LoginFinish(ke3, expectedMAC) == nil
}
