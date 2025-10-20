# Permoney Best Practices Guide

This guide covers best practices for developing and maintaining Permoney, incorporating the latest Ruby 3.4.7 and Rails 8 optimizations.

## Table of Contents

1. [Performance Optimization](#performance-optimization)
2. [Database Queries](#database-queries)
3. [Caching Strategies](#caching-strategies)
4. [Code Quality](#code-quality)
5. [Security](#security)
6. [Testing](#testing)
7. [Frontend](#frontend)

## Performance Optimization

### Ruby 3.4.7 Optimizations

#### Use PRISM Parser Benefits

Ruby 3.4.7 includes PRISM parser by default, which provides:

- Faster parsing and startup times
- Better error messages
- Improved memory efficiency

```ruby
# No configuration needed - PRISM is enabled by default
# Enjoy automatic performance improvements!
```

#### Leverage Improved Memory Management

```ruby
# Use frozen strings for constants
FROZEN_CONSTANT = "immutable_value".freeze

# Or use magic comment at top of file
# frozen_string_literal: true

# Prefer symbols over strings for hash keys
user_data = { name: "John", email: "john@example.com" }
```

### Rails 8 Performance Enhancements

#### Optimize Database Queries

```ruby
# ❌ Bad - N+1 query
users = User.all
users.each { |user| puts user.posts.count }

# ✅ Good - Eager loading
users = User.includes(:posts)
users.each { |user| puts user.posts.size }

# ✅ Better - Use counter cache
# In migration:
add_column :users, :posts_count, :integer, default: 0
# In model:
belongs_to :user, counter_cache: true
```

#### Use Efficient ID Fetching

```ruby
# ❌ Bad
User.pluck(:id)

# ✅ Good - More efficient
User.ids

# ❌ Bad
User.where(active: true).pluck(:id)

# ✅ Good
User.where(active: true).ids
```

#### Batch Processing

```ruby
# ❌ Bad - Loads all records into memory
Post.all.each do |post|
  post.update(processed: true)
end

# ✅ Good - Processes in batches
Post.find_each(batch_size: 1000) do |post|
  post.update(processed: true)
end

# ✅ Better - Use update_all when possible
Post.where(processed: false).update_all(processed: true)
```

## Database Queries

### Query Optimization

#### Use Select to Limit Columns

```ruby
# ❌ Bad - Loads all columns
users = User.all

# ✅ Good - Only loads needed columns
users = User.select(:id, :name, :email)
```

#### Avoid Unnecessary Queries

```ruby
# ❌ Bad - Multiple queries
if User.where(email: email).any?
  user = User.find_by(email: email)
end

# ✅ Good - Single query
if user = User.find_by(email: email)
  # Use user
end
```

#### Use Exists? for Presence Checks

```ruby
# ❌ Bad - Loads records
if User.where(active: true).any?
  # ...
end

# ✅ Good - Only checks existence
if User.where(active: true).exists?
  # ...
end
```

### Indexing Strategy

```ruby
# Always add indexes for:
# - Foreign keys
# - Columns used in WHERE clauses
# - Columns used in ORDER BY
# - Columns used in JOIN conditions

class AddIndexesToAccounts < ActiveRecord::Migration[8.0]
  def change
    add_index :accounts, :user_id
    add_index :accounts, :account_type
    add_index :accounts, [:user_id, :account_type]
    add_index :accounts, :created_at
  end
end
```

### Concurrent Indexing

```ruby
# For production databases, use concurrent indexing
class AddIndexConcurrently < ActiveRecord::Migration[8.0]
  disable_ddl_transaction!

  def change
    add_index :large_table, :column_name, algorithm: :concurrently
  end
end
```

## Caching Strategies

### Memoization

```ruby
# ❌ Bad - Recalculates every time
def expensive_calculation
  # Complex calculation
  result
end

# ✅ Good - Memoizes result
def expensive_calculation
  @expensive_calculation ||= begin
    # Complex calculation
    result
  end
end

# ✅ Better - Handle nil/false values
def expensive_calculation
  return @expensive_calculation if defined?(@expensive_calculation)
  @expensive_calculation = begin
    # Complex calculation
    result
  end
end
```

### Fragment Caching

```erb
<%# Cache expensive view fragments %>
<% cache @user do %>
  <%= render @user %>
<% end %>

<%# Cache with dependencies %>
<% cache [@user, @user.posts] do %>
  <%= render @user.posts %>
<% end %>
```

### Russian Doll Caching

```erb
<%# Outer cache %>
<% cache @post do %>
  <%= render @post %>

  <%# Inner cache - automatically invalidated when comments change %>
  <% @post.comments.each do |comment| %>
    <% cache comment do %>
      <%= render comment %>
    <% end %>
  <% end %>
<% end %>
```

## Code Quality

### Array and Hash Operations

```ruby
# ❌ Bad - Inefficient
array.select { |x| x > 5 }.first

# ✅ Good - More efficient
array.detect { |x| x > 5 }

# ❌ Bad
hash.keys.each { |key| puts key }

# ✅ Good
hash.each_key { |key| puts key }

# ❌ Bad
hash.merge!(single_key: value)

# ✅ Good
hash[single_key] = value
```

### String Operations

```ruby
# ❌ Bad - Creates new string
x = x.strip!

# ✅ Good - Mutates in place
x.strip!

# ❌ Bad - gsub for simple replacements
string.gsub("a", "b")

# ✅ Good - tr is faster
string.tr("a", "b")
```

### File Operations

```ruby
# ❌ Bad
File.read(File.join(Rails.root, "config", "database.yml"))

# ✅ Good - Use Pathname
Rails.root.join("config", "database.yml").read
```

### Method Chaining with Tap

```ruby
# ❌ Bad
x = [1, 2]
x << 3
x << 4
return x

# ✅ Good
[1, 2].tap do |arr|
  arr << 3
  arr << 4
end
```

### Error Handling

```ruby
# ❌ Bad - Rescuing NoMethodError is too broad
begin
  user.profile.name
rescue NoMethodError
  "Unknown"
end

# ✅ Good - Check with respond_to?
if user.respond_to?(:profile) && user.profile.respond_to?(:name)
  user.profile.name
else
  "Unknown"
end

# ✅ Better - Use safe navigation
user&.profile&.name || "Unknown"
```

## Security

### Input Validation

```ruby
class User < ApplicationRecord
  # Always validate presence
  validates :email, presence: true

  # Validate format
  validates :email, format: { with: URI::MailTo::EMAIL_REGEXP }

  # Validate uniqueness
  validates :email, uniqueness: { case_sensitive: false }

  # Validate length
  validates :password, length: { minimum: 8 }
end
```

### Strong Parameters

```ruby
class UsersController < ApplicationController
  def create
    @user = User.new(user_params)
    # ...
  end

  private

  def user_params
    params.require(:user).permit(:name, :email, :password)
  end
end
```

### SQL Injection Prevention

```ruby
# ❌ Bad - SQL injection risk
User.where("email = '#{params[:email]}'")

# ✅ Good - Parameterized query
User.where("email = ?", params[:email])

# ✅ Better - Hash conditions
User.where(email: params[:email])
```

### Mass Assignment Protection

```ruby
# ❌ Bad - Allows any attributes
User.create(params[:user])

# ✅ Good - Use strong parameters
User.create(user_params)
```

## Testing

### Test Structure

```ruby
require "test_helper"

class UserTest < ActiveSupport::TestCase
  setup do
    @user = users(:john)
  end

  test "should be valid with valid attributes" do
    assert @user.valid?
  end

  test "should require email" do
    @user.email = nil
    assert_not @user.valid?
    assert_includes @user.errors[:email], "can't be blank"
  end
end
```

### Performance Testing

```ruby
require "benchmark"

class PerformanceTest < ActiveSupport::TestCase
  test "query performance" do
    time = Benchmark.realtime do
      User.includes(:posts).limit(100).to_a
    end

    assert time < 0.1, "Query took #{time}s, should be under 0.1s"
  end
end
```

### Use Fixtures Efficiently

```ruby
# test/fixtures/users.yml
john:
  name: John Doe
  email: john@example.com

jane:
  name: Jane Smith
  email: jane@example.com

# In tests
@john = users(:john)
@jane = users(:jane)
```

## Frontend

### Stimulus Controllers

```javascript
// ✅ Good - Clean, focused controller
import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["input", "output"];
  static values = { url: String };

  connect() {
    // Initialize
  }

  disconnect() {
    // Cleanup
  }

  submit(event) {
    event.preventDefault();
    // Handle submission
  }
}
```

### Turbo Frames

```erb
<%# ✅ Good - Lazy loading with Turbo Frame %>
<%= turbo_frame_tag "user_profile", src: user_path(@user), loading: :lazy do %>
  <p>Loading...</p>
<% end %>
```

### Asset Organization

```
app/
  javascript/
    controllers/        # Stimulus controllers
    lib/               # Shared JavaScript utilities
    application.js     # Main entry point
  assets/
    builds/           # Compiled assets (Tailwind)
    images/           # Images
    stylesheets/      # Additional CSS
```

## Monitoring and Observability

### Structured Logging

```ruby
# ✅ Good - Structured logging
Rails.logger.info({
  event: "user_created",
  user_id: user.id,
  email: user.email,
  timestamp: Time.current
}.to_json)
```

### Performance Monitoring

```ruby
# Use ActiveSupport::Notifications
ActiveSupport::Notifications.instrument("loan.installment.posted", {
  loan_id: loan.id,
  amount: installment.total_amount
}) do
  # Perform operation
end
```

### Sentry Integration

```ruby
# Capture context for errors
Sentry.configure_scope do |scope|
  scope.set_user(id: current_user.id, email: current_user.email)
  scope.set_context("loan", { id: loan.id, type: loan.subtype })
end
```

## Deployment

### Environment Configuration

```ruby
# config/environments/production.rb

# Enable caching
config.cache_classes = true
config.action_controller.perform_caching = true

# Compress responses
config.middleware.use Rack::Deflater

# Use production logger
config.log_level = :info
config.log_tags = [:request_id]

# Enable asset compilation
config.assets.compile = false
config.assets.digest = true
```

### Database Connection Pooling

```yaml
# config/database.yml
production:
  pool: <%= ENV.fetch("RAILS_MAX_THREADS", 5) %>
  timeout: 5000
  checkout_timeout: 5
```

## Continuous Improvement

### Regular Audits

```bash
# Run security audit
bundle audit check --update

# Check for outdated gems
bundle outdated

# Run linters
bin/rubocop -f github -a
npm run lint:fix

# Run tests
bin/rails test
```

### Performance Profiling

```ruby
# Use Vernier for profiling
require "vernier"

Vernier.profile(out: "profile.json") do
  # Code to profile
end
```

### Code Review Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No N+1 queries
- [ ] Proper indexing
- [ ] Security considerations addressed
- [ ] Error handling implemented
- [ ] Logging added for important operations
- [ ] Performance impact considered

## Resources

- [Ruby 3.4 Release Notes](https://www.ruby-lang.org/en/news/2025/10/07/ruby-3-4-7-released/)
- [Rails 8 Guides](https://guides.rubyonrails.org/)
- [Rails Performance Guide](https://guides.rubyonrails.org/performance_testing.html)
- [Bullet Gem](https://github.com/flyerhzm/bullet) - Detect N+1 queries
- [Rack Mini Profiler](https://github.com/MiniProfiler/rack-mini-profiler) - Performance profiling

## Last Updated

**October 20, 2025** - Updated for Ruby 3.4.7 and Rails 8.0.3
