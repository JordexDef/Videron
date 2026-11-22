# Host your own Videron Sync server

**English** · [Русский](server-setup.ru.md)

Videron Sync 0.46 and later can host several projects on one server. Each project has its own notes and history. Anyone with server access can see the project list. The server stores project names in plain text even when their contents are encrypted. Opening an encrypted project requires its separate space password.

## Install on Linux

Use a Linux VPS or a home virtual machine running systemd, such as Debian or Ubuntu Server. Run `uname -m` to check its architecture. Download the **amd64** archive for `x86_64` or **arm64** for `aarch64`. Extract the archive on the server and change to the directory containing `install.sh` and `videron-sync`.

Pass the address your computers will use to reach the server. Replace the example domain with your own domain or public IP address.

```sh
sudo ./install.sh sync.example.net
```

On the first installation, enter and confirm a server password in the terminal. The `videron-sync` service starts at boot under a dedicated user account and listens on **TCP port 8743**. Give the address and password to the people who need access. After verification, Videron remembers the server identity and stores the credentials for subsequent syncs.

**On a VPS**, use its public IP address or a domain that resolves to that address. Allow incoming traffic on **TCP port 8743** in both the provider's firewall and the active Linux firewall. For UFW, run `sudo ufw allow 8743/tcp`.

## Choose what a browser displays

Since Videron Sync 0.36, visitors to `/` see an interactive landing page by default. To return **404** instead, select `off` during installation. Videron can sync in either mode.

```sh
sudo ./install.sh --landing=off sync.example.net
```

To change an existing installation, run `sudo ./install.sh --landing=off` from the extracted archive. To restore the landing page, run `sudo ./install.sh --landing=interactive`. The installer restarts the service and remembers the setting for future upgrades.

You can also configure this through `sudo systemctl edit videron-sync`. Under `[Service]`, add `Environment=VIDERON_LANDING=off` or `Environment=VIDERON_LANDING=interactive`, then run `sudo systemctl restart videron-sync`. This setting overrides the installer's choice. When running the server manually, use the `VIDERON_LANDING` environment variable or the `-landing=off` or `-landing=interactive` flag. The flag takes precedence over the variable.

## Connect from home through OpenWrt

1. Bridge the VM's network adapter to your home network. In OpenWrt, open **Network → DHCP and DNS → Static Leases** and assign an unused LAN address, such as `192.168.1.50`, to the VM's MAC address. Renew the DHCP lease and run `ip -br address` inside the VM to verify the address.
2. For direct inbound connections, you need a reachable public address. For a changing public IPv4 address, install the `luci-app-ddns` package in OpenWrt. Under **Services → Dynamic DNS**, choose your provider, enter your domain and credentials, and enable updates for the **A** record. Give the installer that domain name. For a static public IPv4 address, you can enter the IP address directly. [OpenWrt DDNS guide](https://openwrt.org/docs/guide-user/services/ddns/client)
3. Under **Network → Firewall → Port Forwards**, add a **TCP** rule from external zone **wan**, port **8743**, to zone **lan**, the VM's LAN address (for example, **192.168.1.50**), and port **8743**. Select **Save & Apply** and allow the same port in the VM's firewall. [OpenWrt firewall configuration](https://openwrt.org/docs/guide-user/firewall/firewall_configuration)
4. Test from a different network, for example by connecting a laptop to a mobile hotspot. In Videron, open **Your server…**, enter the domain and server password, and select **Check connection**.

If that check fails, compare OpenWrt's WAN IPv4 address with the connection's public IPv4 address. A WAN address in `100.64.0.0/10` often indicates carrier-grade NAT (CGNAT). Another home router may also assign a private address to OpenWrt. If you control both routers, forward the port on both or put the upstream router into bridge mode. With ISP-managed CGNAT, request a public address from the provider, host the service on a VPS, or use the tunnel setup below. DDNS keeps the DNS record current. Your provider's network determines whether inbound connections can reach your router. [Shared address space for CGNAT, RFC 6598](https://www.rfc-editor.org/rfc/rfc6598)

## Connect from home through Cloudflare Tunnel

A tunnel works with a private address from your ISP. Run the `cloudflared` connector on the Videron Sync host. Add a public hostname such as `sync.example.net` to the tunnel, choose **TCP**, and point it to `tcp://127.0.0.1:8743`. If the connector runs on another computer, enter the server's LAN address and allow connections from the connector. For a locally managed tunnel, create the DNS route with `cloudflared tunnel route dns TUNNEL_NAME sync.example.net`. [Create a locally managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)

On each client computer, open Videron and enter the public hostname and server password. Videron reaches the tunnel over HTTPS/WebSocket on port 443 and verifies the Videron Sync certificate inside the connection. This mode supports a TCP route protected by the Videron password. An interactive Cloudflare Access login in front of the tunnel requires a separate client. [Cloudflare Tunnel service types](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)

### Use the same hostname in a browser

To serve web traffic and Videron clients from the same address, point the tunnel to the local HTTP listener. Run `cloudflared` on the Videron Sync host, then use `sudo systemctl edit videron-sync` to add the following listener setting. Both landing page modes use it.

```ini
[Service]
Environment=VIDERON_WEB_LISTEN=127.0.0.1:8744
```

Run `sudo systemctl restart videron-sync`, then check the response with `curl -I http://127.0.0.1:8744/`. Expect **200** in `interactive` mode and **404** in `off` mode. When launching manually, set the same address with `-web-listen=127.0.0.1:8744`.

For the sync hostname, choose the **HTTP** service and set the destination to `http://127.0.0.1:8744`. For a locally managed tunnel, update the hostname's `service` field in the YAML configuration and restart the connector. Port 8744 listens on the loopback interface. Videron opens a WebSocket to the same public hostname and verifies the server certificate inside it.

## Connect two computers

1. On the first computer, open the space containing your notes. Click the connection status at the bottom of the sidebar and open the server connection settings. Enter the server address and password. Use `hostname:port` for a custom port. Videron remembers the verified address. Select an existing project or create one. After upgrading a server from 0.45, its original space appears as **Main project**.
2. On the second computer, select the same project and open it from the server. Videron creates a working copy in the app's data directory or offers to open an existing copy. You can also choose your own folder. For an encrypted project, enter the space password.
3. Edit a different note on each computer. After syncing, both changes appear in the space. If Videron asks you to resolve a conflict, compare the versions and select **Apply choices**. To sync manually, use **Your server… → Sync now**.

The bottom of the sidebar shows the server name and connection status for the current space. The dot turns green when connected and loses its green color if the connection drops. Click the status to see the connection type, working folder, and time of the last successful sync. You can retry a failed connection here.

To move the working copy, open **Your server → Projects and folder…** and select a new empty folder. You can move the current working copy with its history and server connection. To start a separate collection of notes, create a new project and give it a name. The original project stays in the server's project list.

## Maintain the server

### Rename or remove a project

With both client and server running version 0.47 or later, open **Your server → Projects and folder…**, select a project, and click **Rename**. Connected computers see the new name on their next sync. They keep their working folders and the password for an encrypted space.

**Delete from server…** asks you to confirm the project by name. It removes the project's notes and history from the server for everyone. Computers that downloaded the project keep their local copies. On their next connection, those copies stop syncing and retain edits made offline. Anyone with access to the server's project list can manage its projects.

To remove a space from one computer's list, open the space switcher and choose **Spaces on this computer… → Remove from list**. By default, the files stay in their folder. For the active space, you can also choose to delete its working copy from disk.

### Upgrade and back up

To upgrade, unpack the new archive and run `sudo ./install.sh` again. The installer keeps the existing public address, server key, and space data in `/var/lib/videron-sync`. To change the public address, pass the new domain or IP address to the installer.

These commands show the service status and its latest log messages.

```sh
systemctl status videron-sync
sudo journalctl -u videron-sync -n 30
```

To change the server password, run `sudo ./install.sh --change-password` from the extracted archive. This revokes access for previously connected devices, including devices paired by code. Reconnect them with the new credentials. When you first enable a password on an older server, its existing connections retain access. For a legacy client, you can display the current pairing code in a private terminal.

```sh
sudo /usr/local/bin/videron-sync -pair -public sync.example.net -data /var/lib/videron-sync
```

To make a backup, stop the service with `sudo systemctl stop videron-sync`, copy the entire `/var/lib/videron-sync` directory with its permissions intact, and restart it with `sudo systemctl start videron-sync`. The backup contains `identity.json`, which holds the private key and pairing secret.
