# Create OAuth applications for first-party apps
# These are the only OAuth apps that will exist - external developers use API keys

# Get configurable values
app_name = defined?(Setting) && Setting.respond_to?(:app_name) ? Setting.app_name : ENV.fetch("APP_NAME", "Permoney")
app_short_name = defined?(Setting) && Setting.respond_to?(:app_short_name) ? Setting.app_short_name : ENV.fetch("APP_SHORT_NAME", "Permoney")
oauth_scopes = defined?(Setting) && Setting.respond_to?(:oauth_default_scopes) ? Setting.oauth_default_scopes : ENV.fetch("OAUTH_DEFAULT_SCOPES", "read_accounts read_transactions read_balances")

# iOS App
ios_app = Doorkeeper::Application.find_or_create_by(name: "#{app_name} iOS") do |app|
  app.redirect_uri = "#{app_short_name.downcase}://oauth/callback"
  app.scopes = oauth_scopes
  app.confidential = false # Public client (mobile app)
end

puts "Created OAuth applications:"
puts "iOS App - Client ID: #{ios_app.uid}"
puts "Scopes: #{oauth_scopes}"
puts ""
puts "External developers should use API keys instead of OAuth."
