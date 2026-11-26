// Package frontend provides the desktop application's bundled WebView assets.
package frontend

import "embed"

//go:embed *.css *.html *.js *.svg icons languages vendor
var Files embed.FS
