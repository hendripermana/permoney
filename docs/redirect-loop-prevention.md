# Redirect Loop Prevention System

## Overview

The Redirect Loop Prevention system implements a robust circuit breaker pattern to detect and prevent infinite redirect loops in the Permoney application. This system provides automatic recovery, detailed logging, and configurable thresholds to ensure application reliability.

## Features

### Circuit Breaker Pattern
The system uses three states to manage redirect loops:

1. **CLOSED** (Normal Operation)
   - Regular request processing
   - Monitors for redirect patterns
   - Tracks redirect history

2. **OPEN** (Loop Detected)
   - Redirect loop detected and circuit opened
   - Redirects to safe fallback path
   - Prevents further loops

3. **HALF-OPEN** (Recovery Testing)
   - Attempts recovery after cooldown period
   - Tests if loop condition is resolved
   - Returns to CLOSED if successful

### Advanced Loop Detection

The system detects multiple redirect patterns:

1. **Self-Redirect**: A → A
2. **Simple Loop**: A → B → A
3. **Complex Loop**: A → B → C → A
4. **Referrer-Based Loop**: Back-and-forth navigation patterns

### Request Fingerprinting

Each user session gets a unique fingerprint based on:
- User ID (or "guest" for unauthenticated users)
- IP address
- User agent (truncated for consistency)
- Session identifier

This ensures accurate loop detection without false positives across different users or sessions.

## Configuration

Configuration is managed through environment variables and Rails configuration:

```ruby
# config/initializers/redirect_loop_prevention.rb

Rails.application.config.redirect_loop_prevention.tap do |config|
  config.enabled = true                    # Enable/disable the system
  config.loop_threshold = 3                # Visits before triggering circuit
  config.history_size = 10                 # Number of paths to track
  config.cooldown_period = 30              # Seconds before recovery attempt
  config.max_redirect_depth = 5            # Maximum redirect chain depth
  config.verbose_logging = true            # Detailed logging
  config.report_to_sentry = true           # Send alerts to Sentry
end
```

### Environment Variables

- `REDIRECT_LOOP_THRESHOLD`: Number of loop detections before opening circuit (default: 3)
- `REDIRECT_HISTORY_SIZE`: Number of paths to track in history (default: 10)
- `REDIRECT_COOLDOWN_PERIOD`: Seconds before attempting recovery (default: 30)
- `MAX_REDIRECT_DEPTH`: Maximum redirect chain to analyze (default: 5)
- `REDIRECT_LOOP_VERBOSE`: Enable verbose logging (default: true in development)
- `REDIRECT_LOOP_SENTRY`: Report to Sentry (default: true in production)

## Safe Paths

The following paths are excluded from loop detection:
- `/rails/*` - Rails internal routes
- `/assets/*` - Static assets
- `/active_storage/*` - File uploads
- `/oauth/*`, `/auth/*` - Authentication flows
- `/sidekiq/*` - Background job dashboard
- `/health` - Health check endpoint
- `/api/*` - API endpoints
- `/pwa/*`, `/manifest`, `/service-worker` - PWA resources

## Fallback Strategy

When a loop is detected, the system determines a safe fallback path based on user state:

1. **Authenticated with Family**: Dashboard (`/`)
2. **Authenticated without Family (Managed)**: Onboarding (`/onboarding`)
3. **Unauthenticated**: Login (`/sessions/new`)
4. **Already at Safe Path**: Renders error page

## Monitoring and Debugging

### Logging

The system provides detailed logging at different levels:

```
[REDIRECT_LOOP_WARNING] - Potential loop detected (below threshold)
[REDIRECT_LOOP_DETECTED] - Loop confirmed, circuit opened
[REDIRECT_LOOP_RECOVERY] - Circuit state transitions
[REDIRECT_LOOP_PREVENTION] - General prevention actions
```

### Sentry Integration

When enabled, the system reports loop detections to Sentry with:
- Current path
- Recent redirect history
- User ID
- IP address

### Session Inspection

Debug redirect loops by inspecting the session:

```ruby
# Rails console
session[:redirect_circuit]
# => {
#   "a1b2c3d4e5f6g7h8" => {
#     status: "closed",
#     history: ["/path1", "/path2", "/path1"],
#     loop_count: 1,
#     last_loop_at: "2024-01-15T10:30:00Z",
#     opened_at: nil,
#     fingerprint: "a1b2c3d4e5f6g7h8"
#   }
# }
```

## Testing

The system includes comprehensive tests:

```bash
# Run redirect loop prevention tests
bin/rails test test/controllers/concerns/redirect_loop_prevention_test.rb
```

Test coverage includes:
- Simple and complex loop patterns
- Circuit breaker state transitions
- Cooldown and recovery mechanisms
- Request type filtering (XHR, Turbo, assets)
- Fallback path determination
- Session cleanup

## Troubleshooting

### Common Issues

1. **False Positives**
   - Increase `loop_threshold` if legitimate navigation triggers detection
   - Check if paths should be added to `safe_paths`

2. **Loops Not Detected**
   - Verify system is enabled
   - Check if request type is being filtered (XHR, Turbo Stream)
   - Review loop patterns in logs

3. **Circuit Stuck Open**
   - Check `cooldown_period` setting
   - Manually clear session: `session[:redirect_circuit] = {}`
   - Verify recovery logic in half-open state

### Manual Circuit Reset

In development or emergency situations:

```ruby
# Rails console
user = User.find_by(email: "user@example.com")
Session.where(user: user).each do |session|
  # Clear redirect circuit data
  session.update(data: session.data.except("redirect_circuit"))
end
```

## Performance Considerations

- **Session Storage**: Circuit state stored in session (minimal overhead)
- **History Tracking**: Limited to configured size (default: 10 paths)
- **Cleanup**: Automatic removal of old fingerprints after 1 hour
- **Pattern Matching**: Optimized algorithms for loop detection

## Best Practices

1. **Keep History Size Reasonable**: 10-20 paths is usually sufficient
2. **Set Appropriate Thresholds**: Balance between safety and user experience
3. **Monitor Logs**: Regular review helps identify navigation issues
4. **Test After Changes**: Verify redirect-heavy features don't trigger false positives
5. **Use Verbose Logging in Development**: Helps understand navigation patterns

## Integration with Other Systems

### Authentication
- Works seamlessly with authentication redirects
- Respects `skip_authentication` directives
- Handles first-login scenarios

### Onboarding
- Coordinates with onboarding flow
- Prevents loops during setup process
- Respects self-hosted vs managed modes

### Impersonation
- Maintains separate fingerprints for impersonation sessions
- Preserves circuit state during role switches

## Future Enhancements

Potential improvements for consideration:

1. **Machine Learning**: Pattern recognition for anomaly detection
2. **User Notifications**: In-app alerts for detected loops
3. **Admin Dashboard**: Visual circuit breaker status monitoring
4. **Rate Limiting Integration**: Combine with request throttling
5. **Custom Recovery Strategies**: Pluggable recovery mechanisms