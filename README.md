# Xray Proxy Ping Server

Live dashboard for proxy ping reports sent by the APK.

## Run on Windows

Double click `start-windows.bat`, or run:

```bat
cd /d E:\xray-proxy-ping-server
node server.js
```

Defaults:

- Dashboard: http://0.0.0.0:8791/
- Health: http://0.0.0.0:8791/health
- Status JSON: http://0.0.0.0:8791/status
- APK report endpoint: `POST /proxy-ping`

For a real phone on the same Wi-Fi, open Windows firewall for TCP port `8791` and set the APK endpoint to your PC LAN IP, e.g. `http://192.168.0.10:8791/proxy-ping`.

Optional environment variables:

- `PROXY_PING_PORT` / `PORT` (default `8791`)
- `PROXY_PING_HOST` (default `0.0.0.0`)
- `PROXY_PING_SECRET` (if set, APK must send matching `x-ping-secret`)
- `PROXY_PING_DATA_DIR` (default `data`)
