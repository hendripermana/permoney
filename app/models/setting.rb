# Dynamic settings the user can change within the app (helpful for self-hosting)
class Setting < RailsSettings::Base
  cache_prefix { "v1" }

  # API Keys
  field :twelve_data_api_key, type: :string, default: ENV["TWELVE_DATA_API_KEY"]
  field :openai_access_token, type: :string, default: ENV["OPENAI_ACCESS_TOKEN"]
  field :brand_fetch_client_id, type: :string, default: ENV["BRAND_FETCH_CLIENT_ID"]

  # User Management
  field :require_invite_for_signup, type: :boolean, default: false
  field :require_email_confirmation, type: :boolean, default: ENV.fetch("REQUIRE_EMAIL_CONFIRMATION", "true") == "true"

  # Branding Configuration
  field :app_name, type: :string, default: ENV.fetch("APP_NAME", "Permoney")
  field :app_short_name, type: :string, default: ENV.fetch("APP_SHORT_NAME", "Permoney")
  field :app_description, type: :string, default: ENV.fetch("APP_DESCRIPTION", "The personal finance app for everyone")
  field :github_repo_owner, type: :string, default: ENV.fetch("GITHUB_REPO_OWNER", "hendripermana")
  field :github_repo_name, type: :string, default: ENV.fetch("GITHUB_REPO_NAME", "permoney")
  field :github_repo_branch, type: :string, default: ENV.fetch("GITHUB_REPO_BRANCH", "main")

  # OAuth Configuration
  field :oauth_default_scopes, type: :string, default: ENV.fetch("OAUTH_DEFAULT_SCOPES", "read_accounts read_transactions read_balances")

  # Deployment Configuration
  field :docker_image_name, type: :string, default: ENV.fetch("DOCKER_IMAGE_NAME", "ghcr.io/hendripermana/permoney")
  field :docker_image_tag, type: :string, default: ENV.fetch("DOCKER_IMAGE_TAG", "latest")
  field :deployment_path, type: :string, default: ENV.fetch("DEPLOYMENT_PATH", "/home/ubuntu/permoney")
end
