# Permoney Dependencies Documentation

This document provides detailed information about Permoney's dependencies, their versions, and update policies.

## Core Runtime

### Ruby
- **Current Version**: 3.4.7
- **Release Date**: October 7, 2025
- **Update Policy**: Follow stable releases, update within 1 month of release
- **Security**: Critical CVE patches applied immediately
- **Documentation**: https://www.ruby-lang.org/en/

#### Ruby 3.4.7 Features
- PRISM parser enabled by default
- Improved memory management
- Security fix for CVE-2025-61594 (URI gem)
- Better performance and startup times

### Bundler
- **Current Version**: 2.7.2
- **Release Date**: September 9, 2025
- **Update Policy**: Update with Ruby releases
- **Documentation**: https://bundler.io/

#### Bundler 2.7.2 Features
- Preparation for Bundler 4 (coming end of 2025)
- Improved error messages
- Better frozen mode validation
- Enhanced dependency resolution

### RubyGems
- **Current Version**: 3.7.2
- **Release Date**: September 9, 2025
- **Update Policy**: Update with Ruby releases
- **Documentation**: https://guides.rubygems.org/

## Backend Framework

### Rails
- **Current Version**: 8.0.3
- **Update Policy**: Follow stable releases
- **Documentation**: https://guides.rubyonrails.org/

#### Key Rails 8 Features Used
- Solid Queue for background jobs
- Solid Cache for caching
- Propshaft for asset pipeline
- Importmap for JavaScript
- Turbo and Stimulus for frontend interactivity

## Database

### PostgreSQL
- **Minimum Version**: 9.3
- **Recommended Version**: 16.x (latest stable)
- **Update Policy**: Use latest stable version
- **Documentation**: https://www.postgresql.org/docs/

### Redis
- **Current Version**: 5.4.1
- **Use Cases**: Caching, session storage, background jobs
- **Documentation**: https://redis.io/docs/

## Frontend Tooling

### Biome
- **Current Version**: 2.2.6
- **Previous Version**: 1.9.4
- **Update Date**: October 2025
- **Purpose**: JavaScript/TypeScript linting and formatting
- **Documentation**: https://biomejs.dev/

#### Migration Notes
- Configuration schema updated from 1.9.x to 2.2.x
- Run `npx @biomejs/biome migrate --write` after upgrade
- New features: improved diagnostics, better performance

### Tailwind CSS
- **Current Version**: 4.3.0 (via tailwindcss-rails)
- **Update Policy**: Follow stable releases
- **Documentation**: https://tailwindcss.com/docs/

### Stimulus
- **Current Version**: 3.x (via stimulus-rails)
- **Purpose**: JavaScript framework for progressive enhancement
- **Documentation**: https://stimulus.hotwired.dev/

### Turbo
- **Current Version**: 2.0.17 (via turbo-rails)
- **Purpose**: SPA-like page navigation without full page reloads
- **Documentation**: https://turbo.hotwired.dev/

## JavaScript Libraries

### React
- **Current Version**: 19.1.1
- **Use Cases**: Complex UI components
- **Documentation**: https://react.dev/

### Framer Motion
- **Current Version**: 12.23.12
- **Purpose**: Animation library
- **Documentation**: https://www.framer.com/motion/

### Zod
- **Current Version**: 4.1.5
- **Purpose**: TypeScript-first schema validation
- **Documentation**: https://zod.dev/

## Cloud Services & APIs

### AWS SDK
- **aws-sdk-s3**: 1.200.0 (updated from 1.177.0)
- **Purpose**: S3 storage for Active Storage
- **Update Date**: October 2025
- **Documentation**: https://docs.aws.amazon.com/sdk-for-ruby/

#### AWS SDK 1.200.0 Updates
- IMDSv2 support for instance credentials
- Improved S3 request signing
- Better error handling and retry logic

### Plaid
- **Current Version**: 44.0.0
- **Purpose**: Bank account integration
- **Documentation**: https://plaid.com/docs/

### Stripe
- **Current Version**: 17.0.1
- **Purpose**: Payment processing
- **Documentation**: https://stripe.com/docs/api

## Data Providers

### Twelve Data
- **Purpose**: Market data and stock prices
- **Status**: Active (replaces discontinued Synth)
- **Documentation**: https://twelvedata.com/docs

### Alpha Vantage
- **Purpose**: Alternative market data provider
- **Status**: Active
- **Documentation**: https://www.alphavantage.co/documentation/

## Background Jobs

### Sidekiq
- **Current Version**: 8.0.8
- **Purpose**: Background job processing
- **Documentation**: https://github.com/sidekiq/sidekiq/wiki

### Sidekiq Cron
- **Current Version**: 2.3.1
- **Purpose**: Scheduled background jobs
- **Documentation**: https://github.com/sidekiq-cron/sidekiq-cron

## Monitoring & Observability

### Sentry
- **sentry-ruby**: 5.28.0
- **sentry-rails**: 5.28.0
- **sentry-sidekiq**: 5.28.0
- **Purpose**: Error tracking and performance monitoring
- **Documentation**: https://docs.sentry.io/platforms/ruby/

### Skylight
- **Current Version**: 7.0.0
- **Purpose**: Application performance monitoring (production only)
- **Documentation**: https://www.skylight.io/support/

### Logtail
- **logtail-rails**: 0.2.11
- **Purpose**: Log aggregation and analysis
- **Documentation**: https://betterstack.com/docs/logs/

### Vernier
- **Current Version**: 1.8.1
- **Purpose**: Ruby profiling
- **Documentation**: https://github.com/jhawthorn/vernier

## Security & Authentication

### Doorkeeper
- **Current Version**: 5.8.2
- **Purpose**: OAuth 2 provider
- **Documentation**: https://doorkeeper.gitbook.io/

### BCrypt
- **Current Version**: 3.1.20
- **Purpose**: Password hashing
- **Documentation**: https://github.com/bcrypt-ruby/bcrypt-ruby

### JWT
- **Current Version**: 3.1.2
- **Purpose**: JSON Web Token handling
- **Documentation**: https://github.com/jwt/ruby-jwt

### ROTP
- **Current Version**: 6.3.0
- **Purpose**: Two-factor authentication (TOTP)
- **Documentation**: https://github.com/mdp/rotp

### RQRCode
- **Current Version**: 3.1.0
- **Purpose**: QR code generation for 2FA
- **Documentation**: https://github.com/whomwah/rqrcode

## File Processing

### RubyZip
- **Current Version**: 3.2.0 (updated from 2.3)
- **Update Date**: October 2025
- **Purpose**: ZIP file handling
- **Documentation**: https://github.com/rubyzip/rubyzip

#### RubyZip 3.2.0 Updates
- Improved security for zip file handling
- Better Unicode support
- Enhanced error messages
- Performance improvements

### Image Processing
- **Current Version**: 1.14.0
- **Purpose**: Image manipulation (via ImageMagick/libvips)
- **Documentation**: https://github.com/janko/image_processing

### Mini Magick
- **Current Version**: 5.3.1
- **Purpose**: ImageMagick wrapper
- **Documentation**: https://github.com/minimagick/minimagick

## Testing

### Minitest
- **Current Version**: 5.26.0
- **Purpose**: Test framework
- **Documentation**: https://github.com/minitest/minitest

### Capybara
- **Current Version**: 3.40.0
- **Purpose**: Integration testing
- **Documentation**: https://github.com/teamcapybara/capybara

### Selenium WebDriver
- **Current Version**: 4.37.0
- **Purpose**: Browser automation for tests
- **Documentation**: https://www.selenium.dev/documentation/

### Mocha
- **Current Version**: 2.7.1
- **Purpose**: Mocking and stubbing
- **Documentation**: https://github.com/freerange/mocha

### VCR
- **Current Version**: 6.3.1
- **Purpose**: HTTP interaction recording for tests
- **Documentation**: https://github.com/vcr/vcr

### WebMock
- **Current Version**: 3.25.1
- **Purpose**: HTTP request stubbing
- **Documentation**: https://github.com/bblimke/webmock

### SimpleCov
- **Current Version**: 0.22.0
- **Purpose**: Code coverage analysis
- **Documentation**: https://github.com/simplecov-ruby/simplecov

## Code Quality

### RuboCop
- **rubocop**: 1.81.1
- **rubocop-rails**: 2.33.4
- **rubocop-performance**: 1.26.1
- **rubocop-rails-omakase**: 1.1.0
- **Purpose**: Ruby code linting and style enforcement
- **Documentation**: https://docs.rubocop.org/

### Brakeman
- **Current Version**: 7.1.0
- **Purpose**: Security vulnerability scanner
- **Documentation**: https://brakemanscanner.org/

### ERB Lint
- **Current Version**: 0.9.0
- **Purpose**: ERB template linting
- **Documentation**: https://github.com/Shopify/erb-lint

## Development Tools

### Ruby LSP
- **ruby-lsp**: 0.26.1
- **ruby-lsp-rails**: 0.4.8
- **Purpose**: Language Server Protocol for Ruby
- **Documentation**: https://shopify.github.io/ruby-lsp/

### Hotwire Livereload
- **Current Version**: 2.1.1
- **Purpose**: Auto-reload during development
- **Documentation**: https://github.com/kirillplatonov/hotwire-livereload

### Letter Opener
- **Current Version**: 1.10.0
- **Purpose**: Preview emails in development
- **Documentation**: https://github.com/ryanb/letter_opener

### Faker
- **Current Version**: 3.5.2
- **Purpose**: Generate fake data for testing
- **Documentation**: https://github.com/faker-ruby/faker

## AI Integration

### Ruby OpenAI
- **Current Version**: 8.3.0
- **Purpose**: OpenAI API integration
- **Documentation**: https://github.com/alexrudall/ruby-openai

### Langfuse
- **Current Version**: 0.1.4
- **Purpose**: LLM observability and analytics
- **Documentation**: https://langfuse.com/docs/

## Internationalization

### I18n
- **Current Version**: 1.14.7
- **Purpose**: Internationalization framework
- **Documentation**: https://guides.rubyonrails.org/i18n.html

### Rails I18n
- **Current Version**: 8.0.2
- **Purpose**: Rails locale data
- **Documentation**: https://github.com/svenfuchs/rails-i18n

### I18n Tasks
- **Current Version**: 1.0.15
- **Purpose**: Manage translation files
- **Documentation**: https://github.com/glebm/i18n-tasks

## UI Components

### View Component
- **Current Version**: 4.0.2
- **Purpose**: Component-based view framework
- **Documentation**: https://viewcomponent.org/

### Lookbook
- **Current Version**: 2.3.13
- **Purpose**: Component preview and documentation
- **Documentation**: https://lookbook.build/

### Hotwire Combobox
- **Current Version**: 0.4.0
- **Purpose**: Accessible combobox component
- **Documentation**: https://github.com/josefarias/hotwire_combobox

### Pagy
- **Current Version**: 9.4.0
- **Purpose**: Pagination
- **Documentation**: https://ddnexus.github.io/pagy/

## Utility Libraries

### Countries
- **Current Version**: 8.0.4
- **Purpose**: Country data and utilities
- **Documentation**: https://github.com/countries/countries

### HTTParty
- **Current Version**: 0.23.2
- **Purpose**: HTTP client
- **Documentation**: https://github.com/jnunemaker/httparty

### Faraday
- **Current Version**: 2.14.0
- **Purpose**: HTTP client library
- **Documentation**: https://lostisland.github.io/faraday/

### Octokit
- **Current Version**: 10.0.0
- **Purpose**: GitHub API client
- **Documentation**: https://github.com/octokit/octokit.rb

## Update Policy

### Security Updates
- **Critical**: Applied immediately (within 24 hours)
- **High**: Applied within 1 week
- **Medium/Low**: Applied in next scheduled update

### Feature Updates
- **Major versions**: Evaluated quarterly, updated with testing
- **Minor versions**: Updated monthly
- **Patch versions**: Updated bi-weekly

### Testing Requirements
Before updating any dependency:
1. Review changelog and breaking changes
2. Update in development environment
3. Run full test suite
4. Test critical user flows manually
5. Deploy to staging for validation
6. Monitor for 24-48 hours before production

## Dependency Monitoring

### Tools Used
- **Dependabot**: Automated dependency updates
- **Bundle Audit**: Security vulnerability scanning
- **npm audit**: JavaScript dependency security

### Commands
```bash
# Check for outdated Ruby gems
bundle outdated

# Check for security vulnerabilities
bundle audit check --update

# Check for outdated npm packages
npm outdated

# Check for npm security issues
npm audit

# Update all dependencies
bundle update
npm update
```

## Support & Resources

- **Ruby**: https://www.ruby-lang.org/en/community/
- **Rails**: https://discuss.rubyonrails.org/
- **Bundler**: https://bundler.io/community.html
- **Permoney Discord**: https://discord.gg/36ZGBsxYEK

## Last Updated

This document was last updated: **October 20, 2025**

For the most current dependency versions, check:
- `Gemfile.lock` for Ruby gems
- `package-lock.json` for JavaScript packages
