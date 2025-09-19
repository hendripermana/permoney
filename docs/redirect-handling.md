# Redirect Handling Best Practices

## Simple Redirect Loop Prevention

Instead of complex circuit breakers, we use simple Rails patterns:

```ruby
# Check current path before redirecting
return if request.path.starts_with?("/onboarding")

# Use proper redirect syntax
redirect_to some_path and return
```

## Benefits

- Simple: Easy to understand and maintain
- Reliable: No false positives or complex state
- Performant: No overhead on every request
- Rails-like: Follows Rails conventions
