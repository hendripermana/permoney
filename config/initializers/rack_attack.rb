# ===========================================================================
# Rack::Attack - Rate Limiting & Throttling
# Protect against abusive requests and improve performance
# ===========================================================================

# TEMPORARILY DISABLED - Debugging NoMethodError
# Only configure Rack::Attack in production
if false # Rails.env.production?

class Rack::Attack

  ### Configure Cache Store ###
  
  # Use Redis for distributed rate limiting
  Rack::Attack.cache.store = ActiveSupport::Cache::RedisCacheStore.new(
    url: ENV.fetch("REDIS_URL", "redis://localhost:6379/1"),
    namespace: "#{ENV.fetch('CACHE_NAMESPACE', 'permoney_production')}:rack_attack",
    expires_in: 1.hour
  )

  ### Throttle Requests ###

  # Throttle all requests by IP (60 req/min per IP)
  throttle('req/ip', limit: 60, period: 1.minute) do |req|
    req.ip unless req.path.start_with?('/up', '/health')
  end

  # Throttle POST requests to login (5 req/min per IP)
  throttle('logins/ip', limit: 5, period: 1.minute) do |req|
    if req.path == '/sessions' && req.post?
      req.ip
    end
  end

  # Throttle API endpoints more aggressively (100 req/min per IP)
  throttle('api/ip', limit: 100, period: 1.minute) do |req|
    if req.path.start_with?('/api/')
      req.ip
    end
  end

  ### Block & Allow ###

  # Always allow localhost
  safelist('allow localhost') do |req|
    req.ip == '127.0.0.1' || req.ip == '::1'
  end

  # Block suspicious patterns
  blocklist('block scrapers') do |req|
    # Block common scraper user agents
    req.user_agent =~ /scrapy|crawl|bot|spider/i
  end

  ### Custom Response ###

  # Return 429 Too Many Requests with Retry-After header
  self.throttled_responder = lambda do |env|
    match_data = env['rack.attack.match_data']
    now = match_data[:epoch_time]
    
    retry_after = match_data[:period] - (now % match_data[:period])

    [
      429,
      {
        'Content-Type' => 'application/json',
        'Retry-After' => retry_after.to_s,
        'X-RateLimit-Limit' => match_data[:limit].to_s,
        'X-RateLimit-Remaining' => '0',
        'X-RateLimit-Reset' => (now + retry_after).to_s
      },
      [{ error: 'Rate limit exceeded. Please try again later.' }.to_json]
    ]
  end

  ### Logging ###

  # Log blocked requests
  ActiveSupport::Notifications.subscribe('rack.attack') do |name, start, finish, request_id, payload|
    req = payload[:request]
    match_type = req.env['rack.attack.match_type']
    
    if [:throttle, :blocklist].include?(match_type)
      Rails.logger.warn(
        "[Rack::Attack] #{match_type} " \
        "#{req.env['rack.attack.matched']} " \
        "IP: #{req.ip} " \
        "Path: #{req.path}"
      )
    end
  end
end

end # Rails.env.production?
