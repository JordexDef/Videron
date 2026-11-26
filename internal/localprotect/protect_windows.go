package localprotect

import (
	"unsafe"

	"videron/internal/syncclient"

	"golang.org/x/sys/windows"
)

func convert(data []byte, protect bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, syncclient.ErrCode
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	buf := unsafe.Slice(out.Data, out.Size)
	defer clear(buf)
	return append([]byte(nil), buf...), nil
}
func Protect(data []byte) ([]byte, error)   { return convert(data, true) }
func Unprotect(data []byte) ([]byte, error) { return convert(data, false) }
