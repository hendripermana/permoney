# Branding configuration initializer
# This provides a centralized way to access branding settings throughout the application

module Branding
  class << self
    # Get app name from settings or environment
    def app_name
      @app_name ||= begin
        if defined?(Setting) && Setting.respond_to?(:app_name)
          Setting.app_name
        else
          ENV.fetch("APP_NAME", "Permoney")
        end
      end
    end

    # Get app short name from settings or environment
    def app_short_name
      @app_short_name ||= begin
        if defined?(Setting) && Setting.respond_to?(:app_short_name)
          Setting.app_short_name
        else
          ENV.fetch("APP_SHORT_NAME", "Permoney")
        end
      end
    end

    # Get app description from settings or environment
    def app_description
      @app_description ||= begin
        if defined?(Setting) && Setting.respond_to?(:app_description)
          Setting.app_description
        else
          ENV.fetch("APP_DESCRIPTION", "The personal finance app for everyone")
        end
      end
    end

    # Get GitHub repository owner from settings or environment
    def github_repo_owner
      @github_repo_owner ||= begin
        if defined?(Setting) && Setting.respond_to?(:github_repo_owner)
          Setting.github_repo_owner
        else
          ENV.fetch("GITHUB_REPO_OWNER", "hendripermana")
        end
      end
    end

    # Get GitHub repository name from settings or environment
    def github_repo_name
      @github_repo_name ||= begin
        if defined?(Setting) && Setting.respond_to?(:github_repo_name)
          Setting.github_repo_name
        else
          ENV.fetch("GITHUB_REPO_NAME", "permoney")
        end
      end
    end

    # Get GitHub repository branch from settings or environment
    def github_repo_branch
      @github_repo_branch ||= begin
        if defined?(Setting) && Setting.respond_to?(:github_repo_branch)
          Setting.github_repo_branch
        else
          ENV.fetch("GITHUB_REPO_BRANCH", "main")
        end
      end
    end

    # Get full GitHub repository URL
    def github_repo_url
      "https://github.com/#{github_repo_owner}/#{github_repo_name}"
    end

    # Get OAuth default scopes from settings or environment
    def oauth_default_scopes
      @oauth_default_scopes ||= begin
        if defined?(Setting) && Setting.respond_to?(:oauth_default_scopes)
          Setting.oauth_default_scopes
        else
          ENV.fetch("OAUTH_DEFAULT_SCOPES", "read_accounts read_transactions read_balances")
        end
      end
    end

    # Clear cached values (useful for testing or when settings change)
    def clear_cache!
      instance_variables.each { |var| remove_instance_variable(var) }
    end
  end
end

# Make branding configuration available globally
Rails.application.config.branding = Branding