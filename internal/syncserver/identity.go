package syncserver

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"time"

	"videron/internal/syncauth"
)

// Commit key, certificate and bearer token as one private file. The
// certificate is pinned by its DER fingerprint and survives address changes.
type identity struct {
	Cert     []byte              `json:"certificate"`
	Key      []byte              `json:"key"`
	Token    string              `json:"token"`
	Password *passwordCredential `json:"password,omitempty"`
}

type passwordCredential struct {
	Registration syncauth.Registration `json:"registration"`
	Token        string                `json:"token"`
}

func (i *identity) pin() string { return fmt.Sprintf("%x", sha256.Sum256(i.Cert)) }

func newBearer() string {
	var token [32]byte
	rand.Read(token[:])
	return hex.EncodeToString(token[:])
}

func (i *identity) certificate() (tls.Certificate, error) {
	cert, err := x509.ParseCertificate(i.Cert)
	if err != nil {
		return tls.Certificate{}, err
	}
	key, err := x509.ParseECPrivateKey(i.Key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if !key.PublicKey.Equal(cert.PublicKey) || !hexID.MatchString(i.Token) {
		return tls.Certificate{}, errors.New("invalid server identity")
	}
	return tls.Certificate{Certificate: [][]byte{i.Cert}, PrivateKey: key, Leaf: cert}, nil
}
func (i *identity) pairing(host string) string {
	return fmt.Sprintf("videron-sync://%s#%s.%s", host, i.pin(), i.Token)
}

func loadIdentity(root *os.Root) (*identity, error) {
	f, err := regularFile(root, "identity.json")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	blob, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return nil, err
	}
	defer clear(blob)
	var id identity
	if err = json.Unmarshal(blob, &id); err != nil {
		return nil, err
	}
	_, err = id.certificate()
	return &id, err
}

func newIdentity() (*identity, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Videron Sync"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	id := new(identity)
	id.Cert, err = x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	id.Key, err = x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	id.Token = newBearer()
	return id, nil
}

func (id *identity) save(root *os.Root) error {
	payload, err := json.Marshal(id)
	if err != nil {
		return err
	}
	defer clear(payload)
	name, _, err := stageFile(root, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer root.Remove(name)
	return root.Rename(name, "identity.json")
}
