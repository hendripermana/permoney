# Docker Hosting Guide

This guide will help you set up Permoney using Docker Compose on your local machine or a cloud VPS.

## Quick Start

1. **Download the Docker Compose file:**
   ```bash
   curl -o compose.yml https://raw.githubusercontent.com/hendripermana/permoney/main/compose.example.yml
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Start the application:**
   ```bash
   docker-compose up -d
   ```

4. **Visit the application:**
   Open your browser and go to `http://localhost:3000`

## Configuration

### Environment Variables

Edit the `.env` file to configure your Permoney instance:

```bash
# Database
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=permoney_production

# Rails
SECRET_KEY_BASE=your_secret_key_base
RAILS_ENV=production

# Optional: OpenAI for AI features
OPENAI_ACCESS_TOKEN=your_openai_token

# Optional: Market data providers
TWELVE_DATA_API_KEY=your_twelve_data_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key

# Optional: Brand Fetch for company logos
BRAND_FETCH_CLIENT_ID=your_brand_fetch_client_id
```

### Generate Secret Key Base

Generate a secure secret key base:

```bash
openssl rand -hex 64
```

## Data Persistence

The Docker Compose configuration includes volumes for data persistence:

- **PostgreSQL data**: `postgres_data` volume
- **Application storage**: `app-storage` volume (for file uploads)

## Updating

To update to the latest version:

```bash
docker-compose pull
docker-compose up -d
```

## Troubleshooting

### Common Issues

1. **Port 3000 already in use:**
   ```bash
   # Change the port in compose.yml
   ports:
     - "3001:3000"  # Use port 3001 instead
   ```

2. **Database connection issues:**
   ```bash
   # Check if the database is running
   docker-compose ps
   
   # View database logs
   docker-compose logs db
   ```

3. **Permission issues:**
   ```bash
   # Fix file permissions
   sudo chown -R $USER:$USER .
   ```

### Getting Help

If you find bugs or have a feature request, be sure to read through our [contributing guide here](https://github.com/hendripermana/permoney/wiki/How-to-Contribute-Effectively-to-Permoney).

## Production Considerations

### Security

- Change default passwords
- Use HTTPS in production
- Set up proper firewall rules
- Regularly update dependencies

### Performance

- Use a reverse proxy (nginx) for SSL termination
- Set up monitoring and logging
- Configure database backups
- Use external Redis if needed

### Scaling

For high-traffic deployments:

```yaml
# Add to compose.yml
services:
  web:
    deploy:
      replicas: 3
    environment:
      - RAILS_MAX_THREADS=5
      
  worker:
    deploy:
      replicas: 2
```

## Docker Images

Permoney provides official Docker images:

- **Latest**: `ghcr.io/hendripermana/permoney:latest`
- **Stable**: `ghcr.io/hendripermana/permoney:stable`

### Building from Source

If you prefer to build your own image:

```bash
git clone https://github.com/hendripermana/permoney.git
cd permoney
docker build -t permoney:local .
```

Then update your `compose.yml`:

```yaml
services:
  web:
    image: permoney:local
  worker:
    image: permoney:local
```

## Support

- **Documentation**: [docs/](https://github.com/hendripermana/permoney/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/hendripermana/permoney/issues)
- **Discussions**: [GitHub Discussions](https://github.com/hendripermana/permoney/discussions)
- **Discord**: [Join our community](https://discord.gg/36ZGBsxYEK)
