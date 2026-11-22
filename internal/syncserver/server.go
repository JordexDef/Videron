package syncserver

import (
	"bytes"
	"cmp"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"
	"videron/internal/syncauth"
)

func portNumber(port string) bool {
	n, err := strconv.Atoi(port)
	return err == nil && n > 0 && n <= 65535
}

func endpoints(listen, public string) ([]string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, err
	}
	if !portNumber(port) {
		return nil, errors.New("use a numeric port between 1 and 65535")
	}
	if public != "" {
		name := strings.TrimPrefix(public, "https://")
		u, err := url.Parse("https://" + name)
		if err != nil || u.Hostname() == "" || u.Hostname() == "." || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Host, "%") {
			return nil, errors.New("invalid -public host or HTTPS URL")
		}
		if u.Port() != "" {
			port = u.Port()
		} else if strings.HasPrefix(public, "https://") {
			port = "443"
		}
		if !portNumber(port) {
			return nil, errors.New("invalid public port")
		}
		return []string{net.JoinHostPort(u.Hostname(), port)}, nil
	}
	ip := net.ParseIP(host)
	if host != "" && (ip == nil || !ip.IsUnspecified()) {
		return []string{net.JoinHostPort(host, port)}, nil
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{"127.0.0.1": true}
	for _, addr := range addrs {
		n, _, err := net.ParseCIDR(addr.String())
		if err == nil && n.IsGlobalUnicast() && !n.IsLinkLocalUnicast() {
			seen[n.String()] = true
		}
	}
	hosts := make([]string, 0, len(seen))
	for ip := range seen {
		hosts = append(hosts, net.JoinHostPort(ip, port))
	}
	sort.Strings(hosts)
	return hosts, nil
}

func Run(args []string, stdout, stderr io.Writer) error {
	return RunWithInput(args, os.Stdin, stdout, stderr)
}

func RunWithInput(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("videron-sync", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listen := flags.String("listen", ":8743", "HTTPS listen host and port")
	webListen := flags.String("web-listen", os.Getenv("VIDERON_WEB_LISTEN"), "optional loopback IP and port for the HTTP landing page and WebSocket tunnel (env VIDERON_WEB_LISTEN)")
	landing := flags.String("landing", cmp.Or(os.Getenv("VIDERON_LANDING"), string(landingInteractive)), "public landing page: interactive or off (env VIDERON_LANDING)")
	public := flags.String("public", "", "advertised host:port or HTTPS URL")
	data := flags.String("data", "", "private server data directory")
	pair := flags.Bool("pair", false, "print the pairing link for an existing server and exit")
	setPassword := flags.Bool("set-password", false, "set or rotate the enrollment password from stdin, then exit")
	status := flags.Bool("password-status", false, "print configured or unset and exit")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected argument (run videron-sync -help)")
	}
	mode := landingMode(*landing)
	if mode != landingInteractive && mode != landingOff {
		return errors.New("-landing must be interactive or off")
	}
	if (*pair && (*setPassword || *status)) || (*setPassword && *status) {
		return errors.New("choose one of -pair, -set-password and -password-status")
	}
	if *data == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		*data = filepath.Join(dir, "VideronSync")
	}
	if *setPassword {
		if err := os.MkdirAll(*data, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(*data)
	if errors.Is(err, fs.ErrNotExist) && *status {
		fmt.Fprintln(stdout, "unset")
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) && !*pair {
		return errors.New("initialize the server with -set-password -data DIR")
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("data must be a directory, not a link")
	}
	root, err := os.OpenRoot(*data)
	if err != nil {
		return err
	}
	defer root.Close()
	if !*pair && !*status {
		lock, err := lockServer(root)
		if err != nil {
			return fmt.Errorf("cannot lock data directory: %w", err)
		}
		defer lock.Close()
		if _, err := recoverStorageDirectory(root); err != nil {
			return err
		}
	}
	id, err := loadIdentity(root)
	if errors.Is(err, fs.ErrNotExist) {
		switch {
		case *status:
			fmt.Fprintln(stdout, "unset")
			return nil
		case *setPassword:
			id, err = newIdentity()
		case !*pair:
			return errors.New("initialize the server with -set-password -data DIR")
		}
	}
	if err != nil {
		return err
	}
	if *setPassword {
		return setIdentityPassword(root, id, stdin, stderr)
	}
	enroll, err := id.enrollment()
	if err != nil {
		return err
	}
	if *status {
		result := "unset"
		if enroll != nil {
			result = "configured"
		}
		fmt.Fprintln(stdout, result)
		return nil
	}
	addresses, err := endpoints(*listen, *public)
	if err != nil {
		return err
	}
	if *pair {
		for _, addr := range addresses {
			fmt.Fprintln(stdout, id.pairing(addr))
		}
		return nil
	}
	cert, err := id.certificate()
	if err != nil {
		return err
	}
	projects, err := openProjectCatalog(root)
	if err != nil {
		return err
	}
	defer projects.close()
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer ln.Close()
	fmt.Fprintf(stderr, "Videron Sync listening on %s\n", ln.Addr())
	server := http.Server{Handler: &service{projects: projects, token: id.Token, enrollment: enroll, landing: mode}, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Minute, WriteTimeout: 15 * time.Minute, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	if *webListen == "" {
		return server.ServeTLS(ln, "", "")
	}
	web, err := listenTunnelWeb(*webListen)
	if err != nil {
		return err
	}
	defer web.Close()
	fmt.Fprintf(stderr, "Videron Sync web listener on %s\n", web.Addr())
	return serveTunnelAndNative(&server, ln, web, mode)
}

func setIdentityPassword(root *os.Root, id *identity, stdin io.Reader, stderr io.Writer) error {
	password, err := readPassword(stdin, stderr)
	if err != nil {
		return err
	}
	defer clear(password)
	registration, err := syncauth.Register(password, id.pin())
	if err != nil {
		return err
	}
	// Enabling passwords on an older installation preserves its pairings.
	// An explicit rotation revokes all previously issued credentials.
	if id.Password != nil {
		id.Token = newBearer()
	}
	id.Password = &passwordCredential{*registration, newBearer()}
	return id.save(root)
}

func readPassword(stdin io.Reader, stderr io.Writer) ([]byte, error) {
	if file, ok := stdin.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		prompt := func(label string) ([]byte, error) {
			fmt.Fprint(stderr, label)
			p, err := term.ReadPassword(int(file.Fd()))
			fmt.Fprintln(stderr)
			return p, err
		}
		first, err := prompt("New server password: ")
		if err != nil {
			return nil, err
		}
		again, err := prompt("Confirm server password: ")
		defer clear(again)
		if err != nil || !bytes.Equal(first, again) {
			clear(first)
			return nil, errors.New("could not confirm server password")
		}
		return first, nil
	}
	// Allow one trailing LF or CRLF from a pipe, preserving spaces verbatim.
	raw, err := io.ReadAll(io.LimitReader(stdin, syncauth.MaxPasswordBytes+3))
	if err != nil {
		return nil, err
	}
	if len(raw) > 0 && raw[len(raw)-1] == '\n' {
		raw = bytes.TrimSuffix(raw[:len(raw)-1], []byte("\r"))
	}
	return raw, nil
}
