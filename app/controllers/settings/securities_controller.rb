class Settings::SecuritiesController < ApplicationController
  layout "settings"

  def show
    @breadcrumbs = [
      { text: "Home", href: root_path, icon: "home" },
      { text: "Security", icon: "shield" }
    ]
  end
end
