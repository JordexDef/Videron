package main

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func convertPairing(data []byte, protect bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errServerCode
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
func protectPairing(data []byte) ([]byte, error)   { return convertPairing(data, true) }
func unprotectPairing(data []byte) ([]byte, error) { return convertPairing(data, false) }
