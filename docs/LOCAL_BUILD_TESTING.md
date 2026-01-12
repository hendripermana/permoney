# Local Docker Build Testing

This guide explains how to build and test Docker images locally before merging to main.

## Quick Start

1. **Build the Docker image locally:**
   ```bash
   ./scripts/build-local-docker.sh
   ```

2. **Set environment variable and start services:**
   ```bash
   export PERMONEY_IMAGE=permoney:local-latest
   docker compose up -d
   ```

3. **To rollback to GitHub image:**
   ```bash
   unset PERMONEY_IMAGE
   # Or explicitly set to GitHub image:
   export PERMONEY_IMAGE=ghcr.io/hendripermana/permoney:sha-0d63490f079585cdd0969e695d97bcedd49f6240
   docker compose up -d
   ```

## How It Works

The `compose.yml` file now supports the `PERMONEY_IMAGE` environment variable:

```yaml
x-app-service: &app_service
  image: ${PERMONEY_IMAGE:-ghcr.io/hendripermana/permoney:sha-0d63490f079585cdd0969e695d97bcedd49f6240}
```

- If `PERMONEY_IMAGE` is set, it uses that image
- If not set, it falls back to the default GitHub image

## Build Script

The build script (`scripts/build-local-docker.sh`) creates two image tags:
- `permoney:local-{branch}-{sha}` - Specific tag with branch and commit SHA
- `permoney:local-latest` - Convenience tag that points to the latest local build

## Testing Workflow

1. **Make your changes and commit them**
2. **Build local image:**
   ```bash
   ./scripts/build-local-docker.sh
   ```
3. **Test with local image:**
   ```bash
   export PERMONEY_IMAGE=permoney:local-latest
   docker compose up -d
   ```
4. **Verify everything works**
5. **Merge to main (CI/CD will build the official image)**
6. **Rollback if needed:**
   ```bash
   unset PERMONEY_IMAGE
   docker compose up -d
   ```

## Notes

- The local build uses the same Dockerfile as CI/CD
- Build arguments (BUILD_COMMIT_SHA, APP_VERSION) are automatically set
- The default GitHub image remains unchanged - you can always rollback
- Local images are not pushed to registry, only stored locally
