module Breadcrumbable
  extend ActiveSupport::Concern

  included do
    before_action :set_breadcrumbs
  end

  private
    # The default, unless specific controller or action explicitly overrides
    # Now uses new hash format with icon support
    def set_breadcrumbs
      @breadcrumbs = [
        { text: "Home", href: root_path, icon: "home" },
        { text: controller_name.titleize, icon: default_controller_icon }
      ]
    end

    # Maps common controller names to appropriate semantic icons
    # Based on 2025 UX best practices for breadcrumb navigation
    def default_controller_icon
      icon_mapping = {
        "accounts" => "wallet",
        "transactions" => "receipt",
        "categories" => "folder",
        "tags" => "tag",
        "merchants" => "store",
        "imports" => "file-up",
        "exports" => "file-down",
        "settings" => "settings",
        "profiles" => "user",
        "securities" => "shield",
        "api_keys" => "key",
        "guides" => "book-open",
        "hostings" => "server",
        "providers" => "plug",
        "ai_prompts" => "sparkles",
        "llm_usages" => "bar-chart",
        "pages" => "layout-dashboard"
      }

      icon_mapping[controller_name] || "file-text"
    end
end
