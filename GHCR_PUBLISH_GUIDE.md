# 📦 Cara Publish Image Permoney ke GHCR.io (Public)

## Untuk Maintainer Repository

Jika kamu ingin image `ghcr.io/hendripermana/permoney:latest` bisa di-pull public tanpa auth, ikuti steps ini:

### 1. Set Package Visibility ke Public

Via GitHub Web UI:
1. Go to: https://github.com/hendripermana?tab=packages
2. Klik package `permoney`
3. Settings → "Change visibility" → **Public**
4. Confirm

### 2. Update GitHub Actions Workflow

File: `.github/workflows/docker-publish.yml` (atau buat baru)

```yaml
name: Publish Docker Image

on:
  push:
    branches: [main]
    tags: ['v*']
  release:
    types: [published]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

### 3. Trigger Build

```bash
git push origin main
# atau
git tag v0.9.6
git push origin v0.9.6
```

### 4. Verify Public Access

Test tanpa auth:
```bash
docker pull ghcr.io/hendripermana/permoney:latest
```

Jika berhasil tanpa auth, image sudah public! ✅

---

## Untuk Users (Saat Ini)

Karena image mungkin belum public, gunakan **build strategy** yang sudah kita setup:

```yaml
# compose.yml (current config)
services:
  web:
    build: 
      context: .
    image: permoney:local

  worker:
    build:
      context: .
    image: permoney:local
```

**Update command:**
```bash
cd /home/ubuntu/permoney
git pull origin main
docker compose build
docker compose up -d
```

---

## Alternative: Use Specific Version

Jika versi tertentu sudah public (misalnya v0.9.5):

```yaml
services:
  web:
    image: ghcr.io/hendripermana/permoney:v0.9.5
  
  worker:
    image: ghcr.io/hendripermana/permoney:v0.9.5
```

Test availability:
```bash
docker pull ghcr.io/hendripermana/permoney:v0.9.5
```
