# Docker Deployment

This guide runs MP3 Platform as a single Docker container behind a private Nginx proxy. The Fastify server serves both the API and the built React web app on port `4318` inside Docker.

## Requirements

- Ubuntu server with Docker Engine and Docker Compose.
- A GitHub repository for this project.
- Access to the published image in GitHub Container Registry.
- A persistent data location for SQLite.
- A mounted music and book library path.

The app stores users, sessions, playlists, scan state, settings, cover art cache, likes, and book progress in SQLite. Keep `/data` persistent.

## NAS Mounts

Mount NAS/SMB/UNC shares as Linux paths before using them in the app. Do not configure Windows UNC paths inside the web UI.

For example, map your SMB shares on the Ubuntu host:

```text
//NAS/Public/Music -> /mnt/nas/music
//NAS/Public/Audiobooks -> /mnt/nas/audiobooks
```

Create a root-owned credentials file on the Ubuntu host:

```bash
sudo install -d -m 700 /etc/samba/credentials
sudo nano /etc/samba/credentials/nas-public
sudo chmod 600 /etc/samba/credentials/nas-public
```

Use this file format:

```text
username=your-nas-user
password=your-nas-password
domain=WORKGROUP
```

For guest/public shares, use `username=guest`, leave `password=` empty, and remove `domain=` if your NAS rejects it.

Then mount the shares:

```bash
sudo mkdir -p /mnt/nas/music /mnt/nas/audiobooks
sudo mount -t cifs //NAS/Public/Music /mnt/nas/music \
  -o credentials=/etc/samba/credentials/nas-public,vers=3.0,uid=1000,gid=1000,iocharset=utf8,file_mode=0664,dir_mode=0775
sudo mount -t cifs //NAS/Public/Audiobooks /mnt/nas/audiobooks \
  -o credentials=/etc/samba/credentials/nas-public,vers=3.0,uid=1000,gid=1000,iocharset=utf8,file_mode=0664,dir_mode=0775
```

Add persistent `/etc/fstab` entries:

```fstab
//NAS/Public/Music /mnt/nas/music cifs credentials=/etc/samba/credentials/nas-public,vers=3.0,uid=1000,gid=1000,iocharset=utf8,file_mode=0664,dir_mode=0775,nofail,x-systemd.automount 0 0
//NAS/Public/Audiobooks /mnt/nas/audiobooks cifs credentials=/etc/samba/credentials/nas-public,vers=3.0,uid=1000,gid=1000,iocharset=utf8,file_mode=0664,dir_mode=0775,nofail,x-systemd.automount 0 0
```

Create an uncommitted `.env` file beside `docker-compose.yml` on the server so Compose can map your host paths into stable container paths:

```bash
MUSIC_LIBRARY_ROOTS=/music
AUDIOBOOK_LIBRARY_ROOTS=/audiobooks
MUSIC_HOST_PATH=/mnt/nas/music
AUDIOBOOK_HOST_PATH=/mnt/nas/audiobooks
MUSIC_CONTAINER_PATH=/music
AUDIOBOOK_CONTAINER_PATH=/audiobooks
```

The Compose file maps the host paths into stable container paths:

```yaml
volumes:
  - /mnt/nas/music:/music
  - /mnt/nas/audiobooks:/audiobooks
```

In the web app, set library roots to `/music` and `/audiobooks`.

If you want the same path inside and outside the container, set both host and container variables to the same value, for example `MUSIC_HOST_PATH=/mnt/music` and `MUSIC_CONTAINER_PATH=/mnt/music`.

Use read-write mounts if you want tag editing, `album.nfo`, `artist.nfo`, cover artwork, and book sidecar state to be written back to the NAS. Use `:ro` mounts only for playback/indexing deployments.

## Compose Deployment

Copy `docker-compose.example.yml` to your server and adjust the host NAS paths.

```bash
mkdir -p /opt/docker/mp3-platform
cd /opt/docker/mp3-platform
nano docker-compose.yml
docker compose pull
docker compose up -d
docker compose logs -f mp3-platform
```

Open through the private Nginx proxy:

```text
http://groovy.local
```

On first visit, create the first user and configure the container paths for your media roots.

## Private Nginx Proxy

The repo includes a private, LAN-only Nginx server block at `deploy/nginx/groovy-local.conf`. The Compose file intentionally uses `expose`, not `ports`, so Groovy is reachable to Nginx on Docker's internal network without opening `4318` on the Ubuntu host.

It allows:

- common private LAN and VPN ranges, which you should narrow to your own network
- localhost

It denies all other clients and proxies to:

```text
http://mp3-platform:4318
```

Install it on the Ubuntu host with:

```bash
sudo cp deploy/nginx/groovy-local.conf /opt/docker/nginx/conf.d/groovy-local.conf
docker network connect groovy_mp3-platform Nginx
docker exec Nginx nginx -t
docker exec Nginx nginx -s reload
```

Keep instance-specific Nginx allow-lists, DNS names, Docker subnets, NAS paths, and credentials in files on your deployment host. Do not commit them back to the public repository.

Do not add a public DNS name, public TLS certificate, host port publication, or router port-forward rule for Groovy until the app is ready to be exposed.

## Updating

For a manual update:

```bash
cd /opt/docker/mp3-platform
docker compose pull
docker compose up -d
docker image prune -f
```

For simple automatic updates, run Watchtower as a separate updater container rather than mounting the Docker socket into MP3 Platform itself.

Example Watchtower service:

```yaml
services:
  watchtower:
    image: containrrr/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --cleanup --interval 3600 mp3-platform
```

One-click updating from inside the MP3 Platform UI should be implemented later through a small, separate updater service with narrow permissions. Avoid giving the main app direct access to the Docker socket.

## Backups

Back up the persistent Docker volume or bind path for `/data`.

At minimum:

```bash
docker run --rm \
  -v mp3-platform-data:/data:ro \
  -v "$PWD:/backup" \
  busybox sh -c 'tar czf /backup/mp3-platform-data.tgz -C /data .'
```

If media mounts are read-write, keep NAS-side backups too because the app can modify tags and sidecar files.
