# Suggested Commands for Permoney

## Setup & Environment
```bash
# Initial setup (installs dependencies, prepares database)
bin/setup

# Copy environment template
cp .env.local.example .env.local
```

## Development Server
```bash
# Start development server (Rails, Sidekiq, Tailwind CSS watcher)
bin/dev

# Start Rails server only
bin/rails server

# Open Rails console
bin/rails console
```

## Testing
```bash
# Run all tests
bin/rails test

# Run tests with database reset
bin/rails test:db

# Run specific test file
bin/rails test test/models/account_test.rb

# Run specific test at line number
bin/rails test test/models/account_test.rb:42

# Run system tests only (use sparingly - they take longer)
bin/rails test:system
```

## Code Quality & Linting
```bash
# Ruby linting with Rubocop
bin/rubocop

# Auto-fix Ruby linting issues
bin/rubocop -A

# Check ERB templates
bundle exec erb_lint ./app/**/*.erb

# Auto-fix ERB linting issues
bundle exec erb_lint ./app/**/*.erb -a

# JavaScript/TypeScript/CSS linting with Biome
npm run lint

# Fix JavaScript/TypeScript/CSS issues
npm run lint:fix

# Format code with Biome
npm run format

# Check formatting with Biome
npm run format:check

# Security analysis
bin/brakeman --no-pager
```

## Database
```bash
# Create and migrate database
bin/rails db:prepare

# Run pending migrations
bin/rails db:migrate

# Rollback last migration
bin/rails db:rollback

# Load seed data
bin/rails db:seed

# Clear cache
bin/rails tmp:cache:clear
```

## Pre-PR Workflow (run before opening PR)
```bash
# 1. Run all tests
bin/rails test

# 2. Run system tests if applicable (use sparingly)
bin/rails test:system

# 3. Ruby linting with auto-fix
bin/rubocop -f github -a

# 4. ERB linting with auto-fix
bundle exec erb_lint ./app/**/*.erb -a

# 5. Security scan
bin/brakeman --no-pager
```

## Useful Development Commands
```bash
# Generate new Rails model
bin/rails generate model ModelName column:type

# Generate new Rails controller
bin/rails generate controller ControllerName action1 action2

# Generate ViewComponent
bin/rails generate component ComponentName

# Generate migration
bin/rails generate migration CreateTableName

# Generate Stimulus controller
bin/rails generate stimulus controller_name

# Rollback database schema
bin/rails db:rollback

# Check database status
bin/rails db:status

# Analyze bundle size/memory
bundle exec derailed bundle:mem
```

## Docker (for self-hosted deployments)
```bash
# Build Docker image
docker build -t permoney .

# Run with Docker Compose
docker-compose -f compose.yml up

# Run with compose.example.yml as template
docker-compose -f compose.example.yml up
```

## System Utilities
```bash
# Search for patterns in code
grep -r "pattern" app/

# List directory structure
ls -la

# Navigate to project root
cd /home/ubuntu/permoney

# View git status
git status

# Commit changes
git commit -m "message"

# Push changes
git push origin branch-name
```

## Performance & Monitoring
```bash
# Access Sidekiq dashboard (in development)
http://localhost:3000/sidekiq

# View Sentry monitoring
https://sentry.io (when configured)

# Check Prometheus metrics
http://localhost:9090 (when configured)

# Memory profiling in production
bin/rails performance:memory_report
```
