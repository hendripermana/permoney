# Permoney Upgrade Guide

This guide covers upgrading Permoney to the latest versions of Ruby, Bundler, and dependencies.

## Current Versions (October 2025)

- **Ruby**: 3.4.7 (released October 7, 2025)
- **Bundler**: 2.7.2 (released September 9, 2025)
- **RubyGems**: 3.7.2 (released September 9, 2025)
- **Rails**: 8.0.3
- **Node.js**: Latest LTS recommended

## Upgrading Ruby

### 1. Update Ruby Version

```bash
# Update .ruby-version file
echo "3.4.7" > .ruby-version

# Install Ruby 3.4.7 (using rbenv)
brew upgrade ruby-build  # Update ruby-build definitions
rbenv install 3.4.7
rbenv rehash

# Verify installation
ruby --version
# => ruby 3.4.7 (2025-10-08 revision 7a5688e2a2) +PRISM [arm64-darwin25]
```

### 2. Update RubyGems and Bundler

```bash
# Update RubyGems to 3.7.2
gem update --system 3.7.2

# Install Bundler 2.7.2
gem install bundler -v 2.7.2

# Verify versions
gem --version      # => 3.7.2
bundler --version  # => Bundler version 2.7.2
```

### 3. Update Dependencies

```bash
# Update Bundler in Gemfile.lock
bundle update --bundler

# Update all gems
bundle update

# Verify everything works
bundle exec rails test
```

## Key Changes in Ruby 3.4.7

### Security Updates
- **CVE-2025-61594**: URI gem security update included
- Enhanced security for URI parsing and validation

### Performance Improvements
- PRISM parser enabled by default for better performance
- Improved memory management
- Faster startup times

### Breaking Changes
- None for applications already on Ruby 3.4.x
- If upgrading from Ruby 3.3 or earlier, review the [Ruby 3.4 release notes](https://www.ruby-lang.org/en/news/2024/12/25/ruby-3-4-0-released/)

## Key Changes in Bundler 2.7.2

### Enhancements
- Improved error messages for source conflicts
- Better frozen mode validation for checksums
- Updated vendored Thor to 1.4.0
- Delayed default path and global cache changes to Bundler 5

### Bug Fixes
- Fixed `bundle cache --frozen` deprecation warnings
- Fixed `bundle lock --update` with `--lockfile` flag
- Fixed `bundle show --verbose` recommendations
- Better handling of edge cases in dependency resolution

### Preparing for Bundler 4
Bundler 2.7 includes a `simulate_version` configuration to test Bundler 4 behavior:

```ruby
# config/application.rb or .bundle/config
bundle config set simulate_version 4
```

See the [Bundler upgrade guide](https://github.com/rubygems/rubygems/blob/master/doc/bundler/UPGRADING.md) for details.

## Upgrading Dependencies

### Major Gem Updates

The following gems were updated to their latest stable versions:

- **aws-sdk-s3**: 1.177.0 → 1.200.0
- **rubyzip**: 2.3 → 3.2
- **@biomejs/biome**: 1.9.4 → 2.2.6

### Biome Configuration Migration

Biome 2.x requires configuration migration:

```bash
# Migrate biome.json to new schema
npx @biomejs/biome migrate --write

# Verify configuration
npm run lint
npm run format
```

### Breaking Changes in Dependencies

#### Rubyzip 3.x
- Improved security for zip file handling
- Better Unicode support
- Enhanced error messages

#### AWS SDK S3 1.200.x
- New IMDSv2 support for instance credentials
- Improved S3 request signing
- Better error handling

## Testing After Upgrade

### 1. Run Test Suite

```bash
# Run all tests
bin/rails test

# Run specific test suites
bin/rails test:system
bin/rails test:models
bin/rails test:controllers
```

### 2. Check Code Quality

```bash
# Run RuboCop
bin/rubocop -f github -a

# Run Brakeman security scan
bin/brakeman --no-pager

# Run JavaScript linting
npm run lint
npm run format:check
```

### 3. Verify Application Functionality

```bash
# Start development server
bin/dev

# Load demo data (optional)
rake demo_data:default

# Visit http://localhost:3000
# Test key features:
# - User authentication
# - Account management
# - Transaction creation
# - Loan management
# - Data synchronization
```

## Troubleshooting

### Ruby Installation Issues

**Problem**: `rbenv: version '3.4.7' is not installed`

**Solution**:
```bash
brew upgrade ruby-build
rbenv install 3.4.7
```

**Problem**: Compilation errors during Ruby installation

**Solution**:
```bash
# Ensure OpenSSL is up to date
brew upgrade openssl@3

# Install with explicit OpenSSL path
RUBY_CONFIGURE_OPTS="--with-openssl-dir=$(brew --prefix openssl@3)" \
  rbenv install 3.4.7
```

### Bundler Issues

**Problem**: `Bundler::GemNotFound` errors

**Solution**:
```bash
# Clear bundler cache
bundle clean --force

# Reinstall gems
bundle install
```

**Problem**: Platform-specific gem issues

**Solution**:
```bash
# Remove platform-specific gems from Gemfile.lock
bundle lock --remove-platform x86_64-linux

# Add current platform
bundle lock --add-platform arm64-darwin

# Reinstall
bundle install
```

### Asset Pipeline Issues

**Problem**: 404 errors for assets in development

**Solution**:
```bash
# Stop bin/dev
# Clear caches
bin/rails tmp:cache:clear

# Restart
bin/dev
```

**Problem**: Importmap not loading modules

**Solution**:
```bash
# Verify importmap configuration
bin/rails importmap:audit

# Pin missing packages
bin/rails importmap:pin <package-name>
```

## Rollback Procedure

If you encounter critical issues after upgrading:

### 1. Revert Ruby Version

```bash
# Restore previous Ruby version
echo "3.4.4" > .ruby-version
rbenv install 3.4.4
rbenv rehash
```

### 2. Revert Gemfile.lock

```bash
# Restore from git
git checkout HEAD -- Gemfile.lock

# Reinstall gems
bundle install
```

### 3. Revert package.json

```bash
# Restore from git
git checkout HEAD -- package.json package-lock.json

# Reinstall packages
npm install
```

## Additional Resources

- [Ruby 3.4.7 Release Notes](https://www.ruby-lang.org/en/news/2025/10/07/ruby-3-4-7-released/)
- [Bundler 2.7.2 Changelog](https://bundler.io/changelog.html)
- [RubyGems 3.7.2 Release](https://blog.rubygems.org/2025/09/09/3.7.2-released.html)
- [Rails 8.0 Upgrade Guide](https://guides.rubyonrails.org/upgrading_ruby_on_rails.html)
- [Biome Migration Guide](https://biomejs.dev/guides/migrate/)

## Support

If you encounter issues during the upgrade:

1. Check [GitHub Issues](https://github.com/hendripermana/permoney/issues)
2. Join our [Discord community](https://discord.gg/36ZGBsxYEK)
3. Review [GitHub Discussions](https://github.com/hendripermana/permoney/discussions)

## Changelog

### October 2025 Upgrade
- ✅ Ruby 3.4.4 → 3.4.7
- ✅ Bundler 2.6.9 → 2.7.2
- ✅ RubyGems 3.6.9 → 3.7.2
- ✅ aws-sdk-s3 1.177.0 → 1.200.0
- ✅ rubyzip 2.3 → 3.2
- ✅ @biomejs/biome 1.9.4 → 2.2.6
- ✅ Biome configuration migrated to v2 schema
- ✅ All dependencies updated to latest stable versions
