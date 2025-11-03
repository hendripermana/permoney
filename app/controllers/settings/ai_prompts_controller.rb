class Settings::AiPromptsController < ApplicationController
  layout "settings"

  def show
    @breadcrumbs = [
      { text: "Home", href: root_path, icon: "home" },
      { text: "AI Prompts", icon: "sparkles" }
    ]
    @family = Current.family
    @assistant_config = Assistant.config_for(OpenStruct.new(user: Current.user))
  end
end
