# Configuration Guide

This guide covers the configuration options available for customizing your Permoney installation, including branding, OAuth settings, and deployment configurations.

## Overview

Permoney supports flexible configuration through:
- Environment variables (`.env` file)
- Database settings (via the Settings model)
- Application initializers

## Branding Configuration

Customize the application branding to match your organization or personal preferences.

### Environment Variables

```bash
# Application Branding
APP_NAME=Permoney                              # Full application name
APP_SHORT_NAME=Permoney                        # Short name for mobile apps
APP_DESCRIPTION=The personal finance app for everyone  # App description

# Repository Configuration
GITHUB_REPO_OWNER=hendripermana               # GitHub repository owner
GITHUB_REPO_NAME=permoney                     # GitHub repository name
GITHUB_REPO_BRANCH=main                       # Default branch
```

### Database Settings

These settings can also be configured through the web interface in Settings > Self-Hosting:

- `app_name` - Full application name displayed in the UI
- `app_short_name` - Short name used for mobile app redirects
- `app_description` - Application description for metadata
- `github_repo_owner` - Repository owner for documentation links
- `github_repo_name` - Repository name for issue tracking
- `github_repo_branch` - Default branch for documentation

### Accessing Branding Settings

In your application code, use the `Branding` module:

```ruby
# Get application name
Branding.app_name

# Get GitHub repository URL
Branding.github_repo_url

# Get app description
Branding.app_description
```

## OAuth Configuration

Configure OAuth applications and scopes for API access.

### Environment Variables

```bash
# OAuth Default Scopes (space-separated)
OAUTH_DEFAULT_SCOPES=read_accounts read_transactions read_balances
```

### Available Scopes

- `read_accounts` - Read account information
- `read_transactions` - Read transaction data
- `read_balances` - Read account balances
- `write` - Write access (use with caution)

### Database Settings

- `oauth_default_scopes` - Default scopes for new OAuth applications

## Deployment Configuration

Configure deployment and rollback settings for production environments.

### Environment Variables

```bash
# Docker Configuration
DOCKER_IMAGE_NAME=ghcr.io/hendripermana/permoney  # Docker image name
DOCKER_IMAGE_TAG=latest                           # Docker image tag

# Deployment Paths
DEPLOYMENT_PATH=/home/ubuntu/permoney             # Application deployment path
COMPOSE_FILE=docker-compose.yml                   # Docker Compose file name

# Rollback Configuration
PREVIOUS_IMAGE=maybe-finance:latest               # Previous version image for rollbacks
```

### Database Settings

- `docker_image_name` - Docker image name for deployments
- `docker_image_tag` - Docker image tag
- `deployment_path` - Server deployment path

## Emergency Rollback

The emergency rollback script (`EMERGENCY_ROLLBACK.sh`) uses these configuration options:

```bash
# Run emergency rollback with custom configuration
APP_NAME="MyFinance" \
DEPLOYMENT_PATH="/opt/myfinance" \
DOCKER_IMAGE_NAME="myregistry/myfinance" \
PREVIOUS_IMAGE="myregistry/myfinance:v1.0" \
./EMERGENCY_ROLLBACK.sh
```

## Configuration Priority

Settings are resolved in the following order (highest to lowest priority):

1. Database settings (via Settings model)
2. Environment variables
3. Default values

## Best Practices

### Security
- Never commit sensitive configuration to version control
- Use environment variables for secrets and API keys
- Regularly rotate OAuth client secrets

### Deployment
- Use specific image tags instead of `latest` in production
- Test rollback procedures in staging environments
- Keep backup copies of configuration files

### Branding
- Use consistent naming across all configuration options
- Update all branding-related settings when rebranding
- Test OAuth redirects after changing app names

## Migration from Hardcoded Values

If you're migrating from a version with hardcoded values:

1. Set environment variables in your `.env` file
2. Update any custom deployment scripts
3. Test OAuth applications with new scopes
4. Verify emergency rollback procedures

## Troubleshooting

### OAuth Issues
- Check that `oauth_default_scopes` matches your API requirements
- Verify redirect URIs use the correct `app_short_name`
- Ensure OAuth applications are recreated after scope changes

### Deployment Issues
- Verify `DEPLOYMENT_PATH` exists and is accessible
- Check that Docker images specified in configuration exist
- Test rollback script in a safe environment first

### Branding Issues
- Clear application cache after changing branding settings
- Update any hardcoded references in custom code
- Verify mobile app redirects work with new short name

## Support

For additional help with configuration:
- Check the [GitHub Issues](https://github.com/hendripermana/permoney/issues)
- Join our [Discord community](https://discord.gg/36ZGBsxYEK)
- Review the [hosting documentation](hosting/)