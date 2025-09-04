# Create OAuth applications for Permoney's first-party apps
# These are the only OAuth apps that will exist - external developers use API keys

# Permoney iOS App
ios_app = Doorkeeper::Application.find_or_create_by(name: "Permoney iOS") do |app|
  app.redirect_uri = "permoney://oauth/callback"
  app.scopes = "read write"
  app.confidential = false # Public client (mobile app)
end

puts "Created OAuth applications:"
puts "iOS App - Client ID: #{ios_app.uid}"
puts ""
puts "External developers should use API keys instead of OAuth."
