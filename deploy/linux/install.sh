#!/bin/sh
# Install the standalone server from the extracted Linux archive.
set -eu
export LC_ALL=C

die() { printf '%s\n' "$*" >&2; exit 1; }

service=videron-sync
state=/var/lib/videron-sync
config=/etc/videron-sync
binary=/usr/local/bin/videron-sync
unit=/etc/systemd/system/videron-sync.service
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    printf '%s\n' \
        'Install: sudo ./install.sh HOST[:PORT]' \
        'Upgrade: sudo ./install.sh' \
        'Change the server password: sudo ./install.sh --change-password' \
        'Hide the browser landing page: sudo ./install.sh --landing=off' \
        'Show the browser landing page: sudo ./install.sh --landing=interactive'
    exit 0
fi
change_password=0
landing=
address=
usage='Usage: sudo ./install.sh [--change-password] [--landing=interactive|off] [HOST[:PORT]]'
for arg do
    case "$arg" in
        --change-password) change_password=1 ;;
        --landing=interactive|--landing=off) landing=${arg#--landing=} ;;
        --landing=*) die "Invalid landing mode. Use --landing=interactive or --landing=off." ;;
        -*|'') die "$usage" ;;
        *) [ -z "$address" ] || die "$usage"; address=$arg ;;
    esac
done
if [ -z "$address" ]; then
    [ -s "$config/public-address" ] || die "Enter the DNS name or IP used by clients: sudo ./install.sh HOST[:PORT]"
    IFS= read -r address < "$config/public-address"
fi
case "$address" in
    *[!0-9A-Za-z.:\[\]-]*|'') die "Use a hostname, IPv4 address or bracketed IPv6 address, optionally followed by :PORT." ;;
esac
if ! printf '%s\n' "$address" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9a-fA-F:]+\])(:[0-9]{1,5})?$'; then
    die "Invalid public address."
fi
case "$address" in
    *]:*|[!\[]*:*) port=${address##*:}; [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "Invalid public port." ;;
esac
[ "$(id -u)" -eq 0 ] || die "Run with sudo."
[ -d /run/systemd/system ] || die "This installer needs Linux with systemd running."
[ -f "$src/videron-sync" ] || die "Extract install.sh and videron-sync from the same archive."
[ ! -L "$state" ] || die "$state must be a directory, not a symlink."

install -d "$config" /usr/local/bin
temp_bin=$(mktemp "${binary}.XXXXXX")
temp_unit=$(mktemp "${unit}.XXXXXX")
temp_addr=$(mktemp "$config/public-address.XXXXXX")
temp_landing=
resume_service=0
cleanup() {
    rm -f -- "$temp_bin" "$temp_unit" "$temp_addr"
    if [ -n "$temp_landing" ]; then
        rm -f -- "$temp_landing"
    fi
    if [ "$resume_service" -eq 1 ]; then
        systemctl start "$service.service"
    fi
}
trap cleanup EXIT
install -m 0755 "$src/videron-sync" "$temp_bin"
"$temp_bin" -help >/dev/null 2>&1 || die "Cannot run the server. Check the archive architecture."

getent group "$service" >/dev/null || groupadd --system "$service"
if ! id "$service" >/dev/null 2>&1; then
    useradd --system --gid "$service" --home-dir "$state" --no-create-home --shell /usr/sbin/nologin "$service"
fi
[ "$(id -u "$service")" -ne 0 ] || die "The service account must be unprivileged."
install -d -m 0700 -o "$service" -g "$service" "$state"
configured=$(runuser -u "$service" -- "$temp_bin" -password-status -data "$state")
if [ "$configured" = unset ] || [ "$change_password" -eq 1 ]; then
    if systemctl is-active --quiet "$service.service"; then
        systemctl stop "$service.service"
        resume_service=1
    fi
    runuser -u "$service" -- "$temp_bin" -set-password -data "$state"
fi

cat > "$temp_unit" <<'UNIT'
[Unit]
Description=Videron Sync
After=network.target

[Service]
Type=exec
User=videron-sync
Group=videron-sync
StateDirectory=videron-sync
StateDirectoryMode=0700
ExecStart=/usr/local/bin/videron-sync -listen :8743 -data /var/lib/videron-sync
Restart=on-failure
RestartSec=4
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
StandardOutput=null
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$temp_unit"
printf '%s\n' "$address" > "$temp_addr"
chmod 0644 "$temp_addr"
if [ -n "$landing" ]; then
    install -d "${unit}.d"
    temp_landing=$(mktemp "${unit}.d/10-landing.XXXXXX")
    printf '[Service]\nEnvironment=VIDERON_LANDING=%s\n' "$landing" > "$temp_landing"
    chmod 0644 "$temp_landing"
    mv -f -- "$temp_landing" "${unit}.d/10-landing.conf"
fi
mv -f -- "$temp_bin" "$binary"
mv -f -- "$temp_unit" "$unit"
mv -f -- "$temp_addr" "$config/public-address"

systemctl daemon-reload
systemctl enable "$service.service"
systemctl restart "$service.service"
resume_service=0
# An upgrade reuses the identity and space already in StateDirectory.
tries=0
while [ "$tries" -lt 10 ]; do
    if [ -s "$state/identity.json" ] && systemctl is-active --quiet "$service.service"; then
        if command -v curl >/dev/null; then
            # This loopback probe sends no credentials. A ready server asks for authentication.
            status=$(curl --noproxy '*' -ks -o /dev/null -w '%{http_code}' --max-time 2 https://127.0.0.1:8743/v1/index) || status=0
            [ "$status" = 401 ] && break
        else
            sleep 1
            systemctl is-active --quiet "$service.service" && break
        fi
    fi
    sleep 1
    tries=$((tries+1))
done
if [ "$tries" -ge 10 ]; then
    die "Service did not start. Run: sudo journalctl -u videron-sync -n 30"
fi
printf '%s\n' "Videron Sync is ready. In Videron, enter $address and your server password."
