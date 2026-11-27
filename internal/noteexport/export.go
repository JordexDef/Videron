// Package noteexport writes portable Markdown folders and ZIP bundles.
package noteexport

import (
	"archive/zip"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

var (
	ErrFormat    = errors.New("VD_EXPORT_FORMAT")
	ErrLimit     = errors.New("VD_EXPORT_LIMIT")
	ErrWrite     = errors.New("VD_EXPORT_WRITE")
	ErrExists    = errors.New("VD_EXPORT_EXISTS")
	ErrCancelled = errors.New("VD_EXPORT_CANCELLED")
)

const (
	maxComponent = 120
	maxEntries   = 20000
	maxPath      = 4096
	maxDepth     = 64
	maxFileBytes = 64 << 20
	maxBytes     = 128 << 20
)

type Bundle struct {
	Name        string   `json:"name"`
	Directories []string `json:"directories,omitempty"`
	Files       []File   `json:"files"`
}

type File struct {
	Path string  `json:"path"`
	Text *string `json:"text,omitempty"`
	Src  string  `json:"src,omitempty"`
}

type entry struct {
	path    string
	text    *string
	encoded string
	mime    string
}

type output struct {
	dirs  []string
	files []entry
}

func unsafeRune(r rune) bool {
	return unicode.IsControl(r) || strings.ContainsRune(`<>:"/\|?*`, r)
}

func deviceName(name string) bool {
	stem, _, _ := strings.Cut(name, ".")
	stem = strings.ToUpper(strings.TrimRight(stem, " "))
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$":
		return true
	}
	for _, prefix := range []string{"COM", "LPT"} {
		if number, ok := strings.CutPrefix(stem, prefix); ok && utf8.RuneCountInString(number) == 1 &&
			strings.Contains("0123456789¹²³", number) {
			return true
		}
	}
	return false
}

func trimName(name string) string {
	return strings.TrimFunc(name, func(r rune) bool { return r == '.' || unicode.IsSpace(r) })
}

// SafeName supplies a portable workspace basename, with room for a ZIP
// extension or a serial suffix if that name already exists.
func SafeName(title string) string {
	name := strings.Map(func(r rune) rune {
		if unsafeRune(r) || r == utf8.RuneError {
			return '-'
		}
		return r
	}, title)
	name = trimName(norm.NFC.String(name))
	const limit = maxComponent - 16
	if len(name) > limit {
		end := limit
		for !utf8.RuneStart(name[end]) {
			end--
		}
		name = trimName(name[:end])
	}
	if name == "" {
		return "Videron"
	}
	if deviceName(name) {
		return "_" + name
	}
	return name
}

func validPath(name string) bool {
	if name == "." || len(name) > maxPath || !fs.ValidPath(name) || strings.Count(name, "/") >= maxDepth {
		return false
	}
	for part := range strings.SplitSeq(name, "/") {
		if len(part) > maxComponent || strings.TrimSpace(part) != part || strings.HasSuffix(part, ".") ||
			strings.IndexFunc(part, unsafeRune) >= 0 || deviceName(part) {
			return false
		}
	}
	return true
}

type claimedPath struct {
	name string
	dir  bool
}

func prepare(bundle Bundle) (output, error) {
	if len(bundle.Files) == 0 {
		return output{}, ErrFormat
	}
	if len(bundle.Files)+len(bundle.Directories) > maxEntries {
		return output{}, ErrLimit
	}
	paths, fold := make(map[string]claimedPath), cases.Fold()
	result := output{files: make([]entry, 0, len(bundle.Files))}
	claim := func(name string, dir bool) error {
		if !validPath(name) {
			return ErrFormat
		}
		for name != "." {
			key := fold.String(norm.NFC.String(name))
			if existing, ok := paths[key]; ok {
				if dir && existing.dir && existing.name == name {
					return nil
				}
				return ErrFormat
			}
			if len(paths) == maxEntries {
				return ErrLimit
			}
			paths[key] = claimedPath{name: name, dir: dir}
			if dir {
				result.dirs = append(result.dirs, name)
			}
			name, dir = path.Dir(name), true
		}
		return nil
	}
	for _, name := range bundle.Directories {
		if err := claim(name, true); err != nil {
			return output{}, err
		}
	}
	remaining := maxBytes
	for _, file := range bundle.Files {
		if err := claim(file.Path, false); err != nil {
			return output{}, err
		}
		item, size, err := prepareFile(file)
		if err != nil {
			return output{}, err
		}
		if size > remaining {
			return output{}, ErrLimit
		}
		remaining -= size
		result.files = append(result.files, item)
	}
	slices.Sort(result.dirs) // Parent entries precede their children.
	return result, nil
}

func prepareFile(file File) (entry, int, error) {
	ext := strings.ToLower(path.Ext(file.Path))
	item := entry{path: file.Path, text: file.Text}
	if file.Text != nil {
		if file.Src != "" || (ext != ".md" && ext != ".csv" && ext != ".tsv") {
			return entry{}, 0, ErrFormat
		}
		if len(*file.Text) > maxFileBytes {
			return entry{}, 0, ErrLimit
		}
		if !utf8.ValidString(*file.Text) {
			return entry{}, 0, ErrFormat
		}
		return item, len(*file.Text), nil
	}
	mime := imageTypes[ext]
	header, encoded, ok := strings.Cut(file.Src, ",")
	if mime == "" || !ok || encoded == "" || header != "data:"+mime+";base64" {
		return entry{}, 0, ErrFormat
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(maxFileBytes) {
		return entry{}, 0, ErrLimit
	}
	unpadded := strings.TrimRight(encoded, "=")
	padding := len(encoded) - len(unpadded)
	if len(encoded)%4 != 0 || padding > 2 || strings.ContainsAny(unpadded, "=\r\n") {
		return entry{}, 0, ErrFormat
	}
	size := base64.StdEncoding.DecodedLen(len(encoded)) - padding
	if size > maxFileBytes {
		return entry{}, 0, ErrLimit
	}
	item.encoded, item.mime = encoded, mime
	return item, size, nil
}

var imageTypes = map[string]string{
	".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".jpeg": "image/jpeg",
	".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}

func (file entry) write(w io.Writer) error {
	if file.text != nil {
		_, err := io.WriteString(w, *file.text)
		return err
	}
	decoded := base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(file.encoded))
	var sample [512]byte
	n, err := io.ReadFull(decoded, sample[:])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return ErrFormat
	}
	mime := http.DetectContentType(sample[:n])
	if n >= 16 && string(sample[4:8]) == "ftyp" &&
		(string(sample[8:12]) == "avif" || string(sample[8:12]) == "avis") {
		mime = "image/avif"
	}
	if mime != file.mime {
		return ErrFormat
	}
	if _, err := w.Write(sample[:n]); err != nil {
		return err
	}
	_, err = io.Copy(w, decoded)
	var malformed base64.CorruptInputError
	if errors.As(err, &malformed) || errors.Is(err, io.ErrUnexpectedEOF) {
		return ErrFormat
	}
	return err
}

func checkAllowed(allowed func() bool) error {
	if allowed != nil && !allowed() {
		return ErrCancelled
	}
	return nil
}

func publishError(err error) error {
	if errors.Is(err, ErrCancelled) || errors.Is(err, ErrFormat) {
		return err
	}
	return ErrWrite
}

func occupied(parent *os.Root, name string) bool {
	_, err := parent.Lstat(name)
	return err == nil
}

// WriteFolder exports into a newly named child of parent. The destination name
// becomes visible only after all files are written and closed.
func WriteFolder(parent string, bundle Bundle, allowed func() bool) (string, error) {
	if err := checkAllowed(allowed); err != nil {
		return "", err
	}
	prepared, err := prepare(bundle)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return "", ErrWrite
	}
	defer root.Close()
	if err := checkAllowed(allowed); err != nil {
		return "", err
	}
	stage := ".videron-export-" + rand.Text()
	if err := root.Mkdir(stage, 0700); err != nil {
		return "", ErrWrite
	}
	defer root.RemoveAll(stage)
	staged, err := root.OpenRoot(stage)
	if err != nil {
		return "", ErrWrite
	}
	err = writeDirectory(staged, prepared, allowed)
	closeErr := staged.Close()
	if err != nil {
		return "", publishError(err)
	}
	if closeErr != nil {
		return "", ErrWrite
	}
	name := SafeName(bundle.Name)
	for attempt := 1; attempt <= 10000; attempt++ {
		candidate := name
		if attempt > 1 {
			candidate += " (" + strconv.Itoa(attempt) + ")"
		}
		if err := checkAllowed(allowed); err != nil {
			return "", err
		}
		err := publish(root, stage, candidate)
		if err == nil {
			return filepath.Join(parent, candidate), nil
		}
		if !errors.Is(err, fs.ErrExist) && !occupied(root, candidate) {
			return "", ErrWrite
		}
	}
	return "", ErrExists
}

func writeDirectory(root *os.Root, prepared output, allowed func() bool) error {
	for _, name := range prepared.dirs {
		if err := checkAllowed(allowed); err != nil {
			return err
		}
		if err := root.Mkdir(filepath.FromSlash(name), 0700); err != nil {
			return err
		}
	}
	for _, item := range prepared.files {
		if err := checkAllowed(allowed); err != nil {
			return err
		}
		file, err := root.OpenFile(filepath.FromSlash(item.path), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		err = item.write(file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// WriteZip publishes a complete archive beside its staging file. Existing
// files and directories at the destination are left intact.
func WriteZip(destination string, bundle Bundle, allowed func() bool) error {
	if err := checkAllowed(allowed); err != nil {
		return err
	}
	name := filepath.Base(destination)
	if !validPath(name) || !strings.EqualFold(filepath.Ext(name), ".zip") {
		return ErrFormat
	}
	prepared, err := prepare(bundle)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(filepath.Dir(destination))
	if err != nil {
		return ErrWrite
	}
	defer root.Close()
	if occupied(root, name) {
		return ErrExists
	}
	if err := checkAllowed(allowed); err != nil {
		return err
	}
	stage := ".videron-export-" + rand.Text()
	file, err := root.OpenFile(stage, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ErrWrite
	}
	defer root.Remove(stage)
	err = writeArchive(file, prepared, allowed)
	closeErr := file.Close()
	if err != nil {
		return publishError(err)
	}
	if closeErr != nil {
		return ErrWrite
	}
	if err := checkAllowed(allowed); err != nil {
		return err
	}
	if err := publish(root, stage, name); err != nil {
		if errors.Is(err, fs.ErrExist) || occupied(root, name) {
			return ErrExists
		}
		return ErrWrite
	}
	return nil
}

func writeArchive(w io.Writer, prepared output, allowed func() bool) error {
	archive := zip.NewWriter(w)
	exportedAt := time.Now().UTC()
	for _, name := range prepared.dirs {
		if err := checkAllowed(allowed); err != nil {
			return err
		}
		header := &zip.FileHeader{Name: name + "/", Modified: exportedAt}
		header.SetMode(os.ModeDir | 0700)
		if _, err := archive.CreateHeader(header); err != nil {
			return err
		}
	}
	for _, item := range prepared.files {
		if err := checkAllowed(allowed); err != nil {
			return err
		}
		header := &zip.FileHeader{Name: item.path, Method: zip.Store, Modified: exportedAt}
		if item.text != nil {
			header.Method = zip.Deflate
		}
		header.SetMode(0600)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		if err := item.write(writer); err != nil {
			return err
		}
	}
	return archive.Close()
}
